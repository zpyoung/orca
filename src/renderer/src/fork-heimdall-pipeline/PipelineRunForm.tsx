import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import { CapabilityModeSchema } from '../../../shared/fork-heimdall/watcher-types'
import { CreateFromPicker } from '@/components/repo/CreateFromPicker'
import { useRepoMap, useWorktreesForRepo } from '@/store/selectors'
import type { PipelineDocument } from '../../../shared/fork-heimdall-pipeline/document-schema'
import type {
  PipelineCapabilityModes,
  PipelineUserCapabilityKey
} from '../../../shared/fork-heimdall-pipeline/capability-grants'
import type { PipelineValidationError } from '../../../shared/fork-heimdall-pipeline/pipeline-validate'
import { ObjectiveWorkspacePicker } from '../fork-heimdall-objective/ObjectiveWorkspacePicker'
import type { ObjectiveWorkspaceOption } from '../fork-heimdall-objective/objective-workspace-options'
import { routeEnrollmentKind } from '../../../shared/fork-heimdall-pipeline/enrollment-routing'
import {
  defaultPipelineGrants,
  pipelineCapabilityChoices,
  startPipelineRun
} from './pipeline-run-start'

const CAPABILITY_COPY: Record<PipelineUserCapabilityKey, { key: string; fallback: string }> = {
  agent: { key: 'fork.heimdallPipeline.runForm.capability.agent', fallback: 'Agent' },
  check: { key: 'fork.heimdallPipeline.runForm.capability.check', fallback: 'Check' },
  script: { key: 'fork.heimdallPipeline.runForm.capability.script', fallback: 'Script' },
  integrate: { key: 'fork.heimdallPipeline.runForm.capability.integrate', fallback: 'Integrate' },
  push: { key: 'fork.heimdallPipeline.runForm.capability.push', fallback: 'Push' },
  land: { key: 'fork.heimdallPipeline.runForm.capability.land', fallback: 'Land' },
  updateBranch: {
    key: 'fork.heimdallPipeline.runForm.capability.updateBranch',
    fallback: 'Update branch'
  },
  resolveConflicts: {
    key: 'fork.heimdallPipeline.runForm.capability.resolveConflicts',
    fallback: 'Resolve conflicts'
  },
  fixChecks: { key: 'fork.heimdallPipeline.runForm.capability.fixChecks', fallback: 'Fix checks' },
  merge: { key: 'fork.heimdallPipeline.runForm.capability.merge', fallback: 'Merge' }
}
const EMPTY_VALIDATION_ERRORS: readonly PipelineValidationError[] = []

function inputDefaults(document: PipelineDocument): Record<string, string> {
  return Object.fromEntries(
    Object.entries(document.inputs).flatMap(([name, definition]) =>
      definition.default === undefined ? [] : [[name, String(definition.default)]]
    )
  )
}

function parseRunInputs(
  document: PipelineDocument,
  values: Readonly<Record<string, string>>
): { values: Record<string, string | number | boolean>; errors: ReadonlySet<string> } {
  const parsed: Record<string, string | number | boolean> = {}
  const errors = new Set<string>()
  for (const [name, definition] of Object.entries(document.inputs)) {
    const value =
      values[name] ?? (definition.default === undefined ? '' : String(definition.default))
    if (value.length === 0) {
      if (definition.required) {
        errors.add(name)
      }
      continue
    }
    if (definition.type === 'number') {
      const number = Number(value)
      if (!Number.isFinite(number)) {
        errors.add(name)
      } else {
        parsed[name] = number
      }
    } else if (definition.type === 'boolean') {
      if (value !== 'true' && value !== 'false') {
        errors.add(name)
      } else {
        parsed[name] = value === 'true'
      }
    } else {
      if (definition.required && value.trim().length === 0) {
        errors.add(name)
      } else {
        parsed[name] = value
      }
    }
  }
  return { values: parsed, errors }
}

function capabilityLabel(key: PipelineUserCapabilityKey): string {
  const copy = CAPABILITY_COPY[key]
  return translate(copy.key, copy.fallback)
}

export type PipelineRunFormProps = {
  pipelineRef: string
  document: PipelineDocument
  validationErrors?: readonly PipelineValidationError[]
  valid?: boolean
  workspaces: readonly ObjectiveWorkspaceOption[]
  selectedWorkspaceKey: string
  onWorkspaceChange: (key: string) => void
  onStarted?: () => void
}

export function PipelineRunForm({
  pipelineRef,
  document,
  validationErrors = EMPTY_VALIDATION_ERRORS,
  valid = true,
  workspaces,
  selectedWorkspaceKey,
  onWorkspaceChange,
  onStarted
}: PipelineRunFormProps): React.JSX.Element {
  const workspaceLabelId = useId()
  const repoMap = useRepoMap()
  const usesRunInputs = routeEnrollmentKind(document) === 'pipeline'
  const eligibleWorkspaces = usesRunInputs
    ? workspaces
    : workspaces.filter((workspace) => !workspace.createsWorktree)
  const selectedWorkspace =
    eligibleWorkspaces.find((workspace) => workspace.key === selectedWorkspaceKey) ?? null
  const worktrees = useWorktreesForRepo(selectedWorkspace?.repoId ?? '')
  const [runInputsDraft, setRunInputsDraft] = useState(() => inputDefaults(document))
  const [grants, setGrants] = useState<PipelineCapabilityModes>(() =>
    defaultPipelineGrants(document)
  )
  const [budgetHours, setBudgetHours] = useState('4')
  const [budgetTurns, setBudgetTurns] = useState('40')
  const [newWorktreeName, setNewWorktreeName] = useState(document.id)
  const [newWorktreeBaseBranch, setNewWorktreeBaseBranch] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputState = parseRunInputs(document, runInputsDraft)
  const choices = pipelineCapabilityChoices(document)
  const hours = Number(budgetHours)
  const turns = Number(budgetTurns)
  const budgetInvalid =
    !Number.isFinite(hours) || hours <= 0 || !Number.isInteger(turns) || turns < 0
  const missingWorkspace = selectedWorkspace === null || selectedWorkspace.ownerUnavailable
  const missingWorktreeName = selectedWorkspace?.createsWorktree === true && !newWorktreeName.trim()
  const formInvalid =
    !valid ||
    (usesRunInputs && inputState.errors.size > 0) ||
    budgetInvalid ||
    missingWorkspace ||
    missingWorktreeName

  const submit = async (): Promise<void> => {
    setError(null)
    if (formInvalid || !selectedWorkspace) {
      return
    }
    setSubmitting(true)
    try {
      await startPipelineRun({
        ref: pipelineRef,
        worktree: selectedWorkspace,
        grants,
        runInputs: usesRunInputs ? inputState.values : {},
        budget: {
          wallClockActiveMs: Math.round(hours * 60 * 60 * 1_000),
          turns
        },
        owner: selectedWorkspace.owner,
        ...(selectedWorkspace.createsWorktree
          ? {
              newWorktree: {
                name: newWorktreeName.trim(),
                ...(newWorktreeBaseBranch.trim()
                  ? { baseBranch: newWorktreeBaseBranch.trim() }
                  : {})
              }
            }
          : {})
      })
      onStarted?.()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
      aria-label={translate('fork.heimdallPipeline.runForm.title', 'Run pipeline')}
    >
      <section className="space-y-3">
        <div className="space-y-1">
          <Label id={workspaceLabelId}>
            {translate('fork.heimdallPipeline.runForm.workspace', 'Workspace')}
          </Label>
          <ObjectiveWorkspacePicker
            value={selectedWorkspaceKey}
            workspaces={eligibleWorkspaces}
            disabled={submitting}
            labelledBy={workspaceLabelId}
            onChange={onWorkspaceChange}
          />
        </div>
        {selectedWorkspace?.ownerUnavailable ? (
          <p className="text-xs text-destructive" role="alert">
            {translate(
              'fork.heimdallPipeline.runForm.ownerUnavailable',
              'The workspace owner is unavailable; no run was sent.'
            )}
          </p>
        ) : null}
        {selectedWorkspace?.createsWorktree ? (
          <section
            className="space-y-2"
            aria-label={translate('fork.heimdallPipeline.runForm.newWorktree', 'New worktree')}
          >
            <div className="space-y-1">
              <Label htmlFor={`${workspaceLabelId}-worktree-name`}>
                {translate('fork.heimdallPipeline.runForm.worktreeName', 'New worktree name')}
              </Label>
              <Input
                id={`${workspaceLabelId}-worktree-name`}
                value={newWorktreeName}
                disabled={submitting}
                aria-invalid={!newWorktreeName.trim()}
                onChange={(event) => setNewWorktreeName(event.currentTarget.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>{translate('fork.heimdallPipeline.runForm.baseBranch', 'Base branch')}</Label>
              <CreateFromPicker
                key={selectedWorkspace.repoId}
                repoId={selectedWorkspace.repoId}
                repoMap={repoMap}
                worktrees={worktrees}
                value={newWorktreeBaseBranch}
                compact
                readOnly={submitting}
                onValueChange={setNewWorktreeBaseBranch}
              />
            </div>
          </section>
        ) : null}
      </section>
      {!valid ? (
        <div className="space-y-1 text-xs text-destructive" role="alert">
          {validationErrors.map((validationError) => (
            <p key={JSON.stringify(validationError)}>
              {validationError.nodeId ?? '-'} {validationError.code}: {validationError.message}
            </p>
          ))}
        </div>
      ) : null}

      {usesRunInputs ? (
        <section
          className="space-y-3"
          aria-label={translate('fork.heimdallPipeline.runForm.inputs', 'Run inputs')}
        >
          <h3 className="text-sm font-medium">
            {translate('fork.heimdallPipeline.runForm.inputs', 'Run inputs')}
          </h3>
          {Object.entries(document.inputs).map(([name, definition]) => (
            <div key={name} className="space-y-1">
              <Label htmlFor={`${workspaceLabelId}-input-${name}`}>
                {definition.label ?? name}
                {definition.required ? ' *' : ''}
              </Label>
              {definition.type === 'boolean' ? (
                <Select
                  value={
                    runInputsDraft[name] ??
                    (definition.default === undefined ? '' : String(definition.default))
                  }
                  onValueChange={(value) =>
                    setRunInputsDraft((current) => ({ ...current, [name]: value }))
                  }
                  disabled={submitting}
                >
                  <SelectTrigger
                    id={`${workspaceLabelId}-input-${name}`}
                    aria-label={definition.label ?? name}
                    aria-invalid={inputState.errors.has(name)}
                  >
                    <SelectValue
                      placeholder={translate(
                        'fork.heimdallPipeline.runForm.chooseBoolean',
                        'Choose true or false'
                      )}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="true">
                      {translate('fork.heimdallPipeline.runForm.true', 'True')}
                    </SelectItem>
                    <SelectItem value="false">
                      {translate('fork.heimdallPipeline.runForm.false', 'False')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id={`${workspaceLabelId}-input-${name}`}
                  type={definition.type === 'number' ? 'number' : 'text'}
                  value={
                    runInputsDraft[name] ??
                    (definition.default === undefined ? '' : String(definition.default))
                  }
                  aria-invalid={inputState.errors.has(name)}
                  disabled={submitting}
                  onChange={(event) => {
                    const value = event.currentTarget.value
                    setRunInputsDraft((current) => ({
                      ...current,
                      [name]: value
                    }))
                  }}
                />
              )}
            </div>
          ))}
        </section>
      ) : null}

      {choices.length > 0 ? (
        <section
          className="space-y-3"
          aria-label={translate('fork.heimdallPipeline.runForm.capabilities', 'Capabilities')}
        >
          <h3 className="text-sm font-medium">
            {translate('fork.heimdallPipeline.runForm.capabilities', 'Capabilities')}
          </h3>
          <div className="space-y-3">
            {choices.map(({ key, requested }) => (
              <div
                key={key}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3 last:border-0"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">{capabilityLabel(key)}</p>
                  <p className="text-xs text-muted-foreground">
                    {translate('fork.heimdallPipeline.runForm.requested', 'Requested {{mode}}', {
                      mode: requested
                    })}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {translate('fork.heimdallPipeline.runForm.granted', 'Granted')}
                  </span>
                  <Select
                    value={grants[key] ?? 'off'}
                    onValueChange={(value) => {
                      const mode = CapabilityModeSchema.safeParse(value)
                      if (mode.success) {
                        setGrants((current) => ({ ...current, [key]: mode.data }))
                      }
                    }}
                    disabled={submitting}
                  >
                    <SelectTrigger
                      aria-label={translate(
                        'fork.heimdallPipeline.runForm.grantedFor',
                        'Granted mode for {{capability}}',
                        { capability: capabilityLabel(key) }
                      )}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="off">
                        {translate('fork.heimdallPipeline.runForm.capabilityMode.off', 'off')}
                      </SelectItem>
                      <SelectItem value="gated">
                        {translate('fork.heimdallPipeline.runForm.capabilityMode.gated', 'gated')}
                      </SelectItem>
                      <SelectItem value="on">
                        {translate('fork.heimdallPipeline.runForm.capabilityMode.on', 'on')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${workspaceLabelId}-hours`}>
            {translate('fork.heimdallPipeline.runForm.activeHours', 'Active-work budget (hours)')}
          </Label>
          <Input
            id={`${workspaceLabelId}-hours`}
            type="number"
            min={0.01}
            step={0.01}
            value={budgetHours}
            aria-invalid={!Number.isFinite(hours) || hours <= 0}
            disabled={submitting}
            onChange={(event) => setBudgetHours(event.currentTarget.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${workspaceLabelId}-turns`}>
            {translate('fork.heimdallPipeline.runForm.turnBudget', 'Turn budget')}
          </Label>
          <Input
            id={`${workspaceLabelId}-turns`}
            type="number"
            min={0}
            step={1}
            value={budgetTurns}
            aria-invalid={!Number.isInteger(turns) || turns < 0}
            disabled={submitting}
            onChange={(event) => setBudgetTurns(event.currentTarget.value)}
          />
        </div>
      </section>

      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={submitting || formInvalid}>
        {submitting
          ? translate('fork.heimdallPipeline.runForm.starting', 'Starting…')
          : translate('fork.heimdallPipeline.runForm.start', 'Start run')}
      </Button>
    </form>
  )
}
