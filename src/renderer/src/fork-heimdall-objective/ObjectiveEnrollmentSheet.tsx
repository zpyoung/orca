import { useEffect, useMemo, useState } from 'react'
import { Loader2, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import { translate } from '@/i18n/i18n'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { useAppStore } from '@/store'
import { objectiveCapabilityModes } from '../../../shared/fork-heimdall-objective/contract-types'
import { ObjectiveEnrollmentFields } from './ObjectiveEnrollmentFields'
import {
  OBJECTIVE_ROLES,
  validateObjectiveEnrollmentDraft,
  type ObjectiveEnrollmentDraft,
  type ObjectiveEnrollmentError
} from './objective-enrollment-model'
import { buildObjectiveEnrollmentSubmission } from './objective-enrollment-request'
import { describeObjectiveError, getObjectiveHeimdallApi } from './objective-heimdall-api'
import { buildObjectiveWorkspaceOptions } from './objective-workspace-options'

const DEFAULT_ACTIVE_BUDGET_HOURS = 4
const DEFAULT_TURN_BUDGET = '40'

function newDraft(): ObjectiveEnrollmentDraft {
  return {
    objectiveText: '',
    tier: 'standard',
    landingBar: 'files-on-disk',
    maxConcurrency: 1,
    workspaceKind: null,
    writeTerritoryText: '',
    capabilities: objectiveCapabilityModes('files-on-disk'),
    roleAgents: { planner: '', implementer: '', reviewer: '', integrator: '' },
    sitterOverrides: {
      updateBranch: 'inherit',
      resolveConflicts: 'inherit',
      fixChecks: 'inherit',
      merge: 'inherit'
    },
    activeBudgetHours: DEFAULT_ACTIVE_BUDGET_HOURS,
    turns: DEFAULT_TURN_BUDGET,
    availableAgentIds: []
  }
}

function validationErrorCopy(error: ObjectiveEnrollmentError): string {
  switch (error.code) {
    case 'workspace-required':
      return translate('fork.heimdallObjective.validation.workspaceRequired', 'Choose a workspace.')
    case 'objective-required':
      return translate('fork.heimdallObjective.validation.objectiveRequired', 'Enter an objective.')
    case 'objective-too-long':
      return translate(
        'fork.heimdallObjective.validation.objectiveTooLong',
        'The objective must be 16,384 characters or fewer.'
      )
    case 'landing-bar-requires-git':
      return translate(
        'fork.heimdallObjective.validation.landingBarRequiresGit',
        'Folder workspaces support only the files-on-disk landing bar.'
      )
    case 'max-concurrency-unsupported':
      return translate(
        'fork.heimdallObjective.validation.maxConcurrency',
        'This release supports exactly one objective worker at a time.'
      )
    case 'territory-required':
      return translate(
        'fork.heimdallObjective.validation.territoryRequired',
        'Add at least one write-territory glob.'
      )
    case 'territory-too-many':
      return translate(
        'fork.heimdallObjective.validation.territoryTooMany',
        'Write territory supports at most 64 globs.'
      )
    case 'territory-duplicate':
      return translate(
        'fork.heimdallObjective.validation.territoryDuplicate',
        'Write-territory globs must be unique.'
      )
    case 'territory-invalid':
      return translate(
        'fork.heimdallObjective.validation.territoryInvalid',
        'Invalid write-territory glob: {{glob}}',
        { glob: error.value ?? '' }
      )
    case 'capability-set-invalid':
      return translate(
        'fork.heimdallObjective.validation.capabilitiesInvalid',
        'All five objective capabilities must be configured.'
      )
    case 'role-agent-unknown':
      return translate(
        'fork.heimdallObjective.validation.roleAgentUnknown',
        'Agent {{agent}} is not available on the selected workspace host.',
        { agent: error.value ?? '' }
      )
    case 'active-budget-invalid':
      return translate(
        'fork.heimdallObjective.validation.activeBudgetInvalid',
        'Choose a positive active-work budget.'
      )
    case 'turn-budget-invalid':
      return translate(
        'fork.heimdallObjective.validation.turnBudgetInvalid',
        'Worker turns must be a whole number of zero or more.'
      )
  }
}

export type ObjectiveEnrollmentSheetProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ObjectiveEnrollmentSheet({
  open,
  onOpenChange
}: ObjectiveEnrollmentSheetProps): React.JSX.Element {
  const repos = useAppStore((state) => state.repos)
  const worktreesByRepo = useAppStore((state) => state.worktreesByRepo)
  const runtimeEnvironments = useAppStore((state) => state.runtimeEnvironments)
  const detectedAgentIds = useAppStore((state) => state.detectedAgentIds)
  const remoteDetectedAgentIds = useAppStore((state) => state.remoteDetectedAgentIds)
  const runtimeDetectedAgentIds = useAppStore((state) => state.runtimeDetectedAgentIds)
  const settings = useAppStore((state) => state.settings)
  const hydrateFleet = useAppStore((state) => state.hydrateHeimdallFleet)
  const workspaces = useMemo(
    () =>
      buildObjectiveWorkspaceOptions({
        repos,
        worktreesByRepo,
        runtimeEnvironments,
        detectedAgentIds,
        remoteDetectedAgentIds,
        runtimeDetectedAgentIds,
        settings
      }),
    [
      detectedAgentIds,
      remoteDetectedAgentIds,
      repos,
      runtimeDetectedAgentIds,
      runtimeEnvironments,
      settings,
      worktreesByRepo
    ]
  )
  const [selectedWorkspaceKey, setSelectedWorkspaceKey] = useState('')
  const [draft, setDraft] = useState<ObjectiveEnrollmentDraft>(newDraft)
  const [showValidation, setShowValidation] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const selectedWorkspace = workspaces.find((workspace) => workspace.key === selectedWorkspaceKey)
  const validationErrors = validateObjectiveEnrollmentDraft(draft)

  useEffect(() => {
    if (!selectedWorkspace) {
      if (selectedWorkspaceKey) {
        setSelectedWorkspaceKey('')
        setDraft((current) => ({
          ...current,
          workspaceKind: null,
          roleAgents: { planner: '', implementer: '', reviewer: '', integrator: '' },
          availableAgentIds: []
        }))
      }
      return
    }
    const availableAgentIds = selectedWorkspace.availableAgentIds
    const unavailableRole = OBJECTIVE_ROLES.some((role) => {
      const agentId = draft.roleAgents[role]
      return agentId && !availableAgentIds.includes(agentId)
    })
    if (
      draft.workspaceKind !== selectedWorkspace.workspaceKind ||
      unavailableRole ||
      draft.availableAgentIds.join('\0') !== availableAgentIds.join('\0')
    ) {
      setDraft((current) => ({
        ...current,
        workspaceKind: selectedWorkspace.workspaceKind,
        landingBar:
          selectedWorkspace.workspaceKind === 'folder' ? 'files-on-disk' : current.landingBar,
        capabilities:
          selectedWorkspace.workspaceKind === 'folder' && current.landingBar !== 'files-on-disk'
            ? { ...current.capabilities, land: 'on' }
            : current.capabilities,
        roleAgents: Object.fromEntries(
          OBJECTIVE_ROLES.map((role) => [
            role,
            availableAgentIds.includes(current.roleAgents[role]) ? current.roleAgents[role] : ''
          ])
        ) as ObjectiveEnrollmentDraft['roleAgents'],
        availableAgentIds
      }))
    }
  }, [draft, selectedWorkspace, selectedWorkspaceKey])

  const selectWorkspace = (key: string): void => {
    const workspace = workspaces.find((candidate) => candidate.key === key)
    setSelectedWorkspaceKey(key)
    setServerError(null)
    setDraft((current) => ({
      ...current,
      workspaceKind: workspace?.workspaceKind ?? null,
      landingBar: workspace?.workspaceKind === 'folder' ? 'files-on-disk' : current.landingBar,
      capabilities:
        workspace?.workspaceKind === 'folder' && current.landingBar !== 'files-on-disk'
          ? { ...current.capabilities, land: 'on' }
          : current.capabilities,
      roleAgents: { planner: '', implementer: '', reviewer: '', integrator: '' },
      availableAgentIds: workspace?.availableAgentIds ?? []
    }))
  }

  const submit = async (): Promise<void> => {
    setShowValidation(true)
    setServerError(null)
    const api = getObjectiveHeimdallApi()
    if (!api) {
      setServerError(
        translate(
          'fork.heimdallObjective.enrollment.serviceUnavailable',
          'Heimdall enrollment is not available in this client.'
        )
      )
      return
    }
    if (!selectedWorkspace || validationErrors.length > 0) {
      return
    }
    if (selectedWorkspace.ownerUnavailable) {
      setServerError(
        translate(
          'fork.heimdallObjective.enrollment.ownerUnavailable',
          'The workspace owner is unavailable; no enrollment was sent.'
        )
      )
      return
    }

    const submission = buildObjectiveEnrollmentSubmission(draft, selectedWorkspace)

    setSubmitting(true)
    try {
      await api.enroll(submission.input, submission.owner)
      await hydrateFleet()
      setDraft(newDraft())
      setSelectedWorkspaceKey('')
      setShowValidation(false)
      onOpenChange(false)
    } catch (error) {
      setServerError(describeObjectiveError(error))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          setServerError(null)
          setShowValidation(false)
        }
        onOpenChange(nextOpen)
      }}
    >
      <SheetContent className="w-[min(620px,calc(100vw-1rem))] sm:max-w-[620px]">
        <SheetHeader className="border-b border-border pr-12">
          <SheetTitle>
            {translate('fork.heimdallObjective.enrollment.title', 'New objective')}
          </SheetTitle>
          <SheetDescription>
            {translate(
              'fork.heimdallObjective.enrollment.description',
              'Define the contract Heimdall will plan, execute, review, and land.'
            )}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 scrollbar-sleek">
          <ObjectiveEnrollmentFields
            draft={draft}
            selectedWorkspaceKey={selectedWorkspaceKey}
            workspaces={workspaces}
            agents={getAgentCatalog()}
            disabled={submitting}
            onWorkspaceChange={selectWorkspace}
            onDraftChange={setDraft}
          />
          {showValidation && validationErrors.length > 0 ? (
            <div
              className="mt-5 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              role="alert"
            >
              <div className="flex items-center gap-2 font-medium">
                <TriangleAlert className="size-3.5" aria-hidden />
                {translate(
                  'fork.heimdallObjective.enrollment.validationTitle',
                  'Fix the contract before starting'
                )}
              </div>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {validationErrors.map((error, index) => (
                  <li key={`${error.code}:${error.value ?? ''}:${index}`}>
                    {validationErrorCopy(error)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {serverError ? (
            <p className="mt-5 text-xs text-destructive" role="alert">
              {serverError}
            </p>
          ) : null}
        </div>
        <footer className="flex shrink-0 justify-end gap-2 border-t border-border p-4">
          <SheetClose asChild>
            <Button type="button" variant="outline" disabled={submitting}>
              {translate('fork.heimdallObjective.enrollment.cancel', 'Cancel')}
            </Button>
          </SheetClose>
          <Button type="button" disabled={submitting} onClick={() => void submit()}>
            {submitting ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {translate('fork.heimdallObjective.enrollment.submit', 'Start objective')}
          </Button>
        </footer>
      </SheetContent>
    </Sheet>
  )
}
