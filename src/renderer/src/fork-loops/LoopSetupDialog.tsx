import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import { translate } from '@/i18n/i18n'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { useAppStore } from '@/store'
import {
  defaultSessionPolicyForPreset,
  LoopCreateInputSchema,
  LoopPresetSchema,
  LoopSessionPolicySchema,
  type LoopConfig,
  type LoopCreateInput,
  type LoopPreset
} from '../../../shared/fork-loops/loop-types'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  DEFAULT_DISABLED_TUI_AGENTS,
  filterEnabledTuiAgents
} from '../../../shared/tui-agent-selection'
import { selectLoopsForWorktree } from './loops-slice'
import {
  CheckboxField,
  Field,
  SelectField,
  TextField,
  wholeNumberError,
  LoopSetupAdvancedFields,
  type FieldError,
  type LoopSetupDraft,
  type SectionProps
} from './LoopSetupAdvancedFields'

const DEFAULT_MAX_ITERATIONS = '10'
const COST_REPORTING_AGENTS: readonly string[] = ['claude', 'codex']
const AUTO_NAME_MAX_LENGTH = 48
const DEFAULT_CHECK_TIMEOUT_SECONDS = '300'

const INITIAL_DRAFT: LoopSetupDraft = {
  name: '',
  agent: null,
  preset: 'until-done',
  prompt: '',
  repeatQueue: false,
  intervalMinutes: '30',
  anchor: 'from-end',
  sessionPolicy: defaultSessionPolicyForPreset('until-done'),
  maxIterations: DEFAULT_MAX_ITERATIONS,
  maxActiveMinutes: '',
  maxCostUsd: '',
  checkCommand: '',
  checkTimeoutSeconds: DEFAULT_CHECK_TIMEOUT_SECONDS,
  checkRunWhen: 'every-iteration',
  evaluatorCondition: '',
  protectedPaths: '',
  noProgress: true,
  checkpointCommits: false,
  askBeforeNext: false,
  resumeAtLimitReset: false
}

function presetLabel(preset: LoopPreset): string {
  if (preset === 'interval') {
    return translate('fork.loops.setup.presetInterval', 'On an interval')
  }
  if (preset === 'queue') {
    return translate('fork.loops.setup.presetQueue', 'Queue')
  }
  return translate('fork.loops.setup.presetUntilDone', 'Until done')
}

function autoName(draft: LoopSetupDraft): string {
  const firstLine = draft.prompt.trim().split('\n')[0] ?? ''
  return draft.name.trim() || firstLine.slice(0, AUTO_NAME_MAX_LENGTH) || presetLabel(draft.preset)
}

const FIELD_ERROR_BY_PATH: Record<string, FieldError> = {
  'config.pacing.minutes': 'interval',
  'config.caps.maxIterations': 'iterations',
  'config.caps.maxActiveMinutes': 'activeMinutes',
  'config.done.check.timeoutSeconds': 'checkTimeout',
  'config.caps.maxCostUsd': 'cost'
}

/** Empty text means "unset"; anything else that is not a valid number is left for the schema to reject. */
function optionalNumber(text: string): number | undefined {
  return text.trim() === '' ? undefined : Number(text)
}

/** Builds the create payload and reports invalid fields by running it through `LoopCreateInputSchema`. */
function buildLoopCreateInput(
  draft: LoopSetupDraft,
  worktreeId: string,
  agent: TuiAgent,
  showCost: boolean
): { input: LoopCreateInput } | { errors: Set<FieldError> } {
  const checkCommand = draft.checkCommand.trim()
  const evaluatorCondition = draft.evaluatorCondition.trim()
  const protectedPaths = draft.protectedPaths
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const config: LoopConfig = {
    promptSource:
      draft.preset === 'queue'
        ? { kind: 'queue', repeatQueue: draft.repeatQueue }
        : { kind: 'repeat', body: draft.prompt.trim() },
    pacing:
      draft.preset === 'interval'
        ? {
            kind: 'interval',
            minutes: optionalNumber(draft.intervalMinutes) ?? Number.NaN,
            anchor: draft.anchor
          }
        : { kind: 'on-idle' },
    sessionPolicy: draft.sessionPolicy,
    done: {
      ...(checkCommand !== ''
        ? {
            check: {
              command: checkCommand,
              timeoutSeconds: optionalNumber(draft.checkTimeoutSeconds) ?? Number.NaN,
              runWhen: draft.checkRunWhen
            }
          }
        : {}),
      ...(evaluatorCondition !== '' ? { evaluator: { condition: evaluatorCondition } } : {})
    },
    caps: {
      maxIterations: optionalNumber(draft.maxIterations),
      maxActiveMinutes: optionalNumber(draft.maxActiveMinutes),
      maxCostUsd: showCost ? optionalNumber(draft.maxCostUsd) : undefined
    },
    noProgress: draft.noProgress,
    protectedPaths: protectedPaths.length > 0 ? protectedPaths : undefined,
    checkpointCommits: draft.checkpointCommits,
    askBeforeNext: draft.askBeforeNext,
    resumeAtLimitReset: draft.resumeAtLimitReset
  }
  const input: LoopCreateInput = {
    worktreeId,
    name: autoName(draft),
    agent,
    preset: draft.preset,
    config
  }
  const errors = new Set<FieldError>()
  if (draft.preset !== 'queue' && draft.prompt.trim() === '') {
    errors.add('prompt')
  }
  for (const issue of LoopCreateInputSchema.safeParse(input).error?.issues ?? []) {
    const field = FIELD_ERROR_BY_PATH[issue.path.join('.')]
    if (field) {
      errors.add(field)
    }
  }
  return errors.size > 0 ? { errors } : { input }
}

function useSelectableAgents(worktreeId: string): {
  agents: { id: TuiAgent; label: string }[]
  isLocalHost: boolean
} {
  const target = useAgentDetectionTargetForWorktree(worktreeId)
  const { detectedIds } = useDetectedAgents(target)
  const defaultAgent = useAppStore((s) => s.settings?.defaultTuiAgent)
  const disabledAgents = useAppStore(
    (s) => s.settings?.disabledTuiAgents ?? DEFAULT_DISABLED_TUI_AGENTS
  )
  const enabled = detectedIds ? filterEnabledTuiAgents(detectedIds, disabledAgents) : []
  const isDefault = (id: TuiAgent): number => (id === defaultAgent ? 0 : 1)
  const agents = getAgentCatalog()
    .filter((entry) => enabled.includes(entry.id))
    .sort((a, b) => isDefault(a.id) - isDefault(b.id))
  return { agents, isLocalHost: target?.kind === 'local' }
}

function PresetFields({ draft, errors, update }: SectionProps): React.JSX.Element {
  if (draft.preset === 'queue') {
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          {translate(
            'fork.loops.setup.queueHelp',
            'Prompts are added to the queue from the loop rail after it starts. Each iteration sends the next one.'
          )}
        </p>
        <CheckboxField
          id="loop-setup-repeat-queue"
          label={translate('fork.loops.setup.repeatQueue', 'Start over when the queue is empty')}
          checked={draft.repeatQueue}
          onChange={(repeatQueue) => update({ repeatQueue })}
        />
      </div>
    )
  }
  return (
    <>
      <TextField
        id="loop-setup-prompt"
        rows={4}
        label={translate('fork.loops.setup.prompt', 'Prompt')}
        placeholder={translate(
          'fork.loops.setup.promptPlaceholder',
          'What should the agent do on every iteration?'
        )}
        value={draft.prompt}
        error={
          errors.has('prompt')
            ? translate('fork.loops.setup.errorPrompt', 'Enter a prompt to start the loop.')
            : undefined
        }
        onChange={(prompt) => update({ prompt })}
      />
      {draft.preset === 'interval' ? (
        <div className="grid grid-cols-2 gap-3">
          <TextField
            inputMode="numeric"
            id="loop-setup-interval"
            label={translate('fork.loops.setup.intervalMinutes', 'Run every (minutes)')}
            value={draft.intervalMinutes}
            error={errors.has('interval') ? wholeNumberError() : undefined}
            onChange={(intervalMinutes) => update({ intervalMinutes })}
          />
          <SelectField
            label={translate('fork.loops.setup.intervalAnchor', 'Counted from')}
            value={draft.anchor}
            options={[
              {
                value: 'from-end',
                label: translate('fork.loops.setup.anchorFromEnd', 'End of the last iteration')
              },
              {
                value: 'wall-clock',
                label: translate('fork.loops.setup.anchorWallClock', 'The clock')
              }
            ]}
            onChange={(value) =>
              update({ anchor: value === 'wall-clock' ? 'wall-clock' : 'from-end' })
            }
          />
        </div>
      ) : null}
    </>
  )
}

function LoopSetupForm({
  worktreeId,
  onOpenChange
}: {
  worktreeId: string
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<LoopSetupDraft>(INITIAL_DRAFT)
  const [submitting, setSubmitting] = useState(false)
  const { agents, isLocalHost } = useSelectableAgents(worktreeId)
  const loops = useAppStore((s) => selectLoopsForWorktree(s, worktreeId))
  const applyLoopSnapshot = useAppStore((s) => s.applyLoopSnapshot)
  const hasRunningLoop = loops.some((loop) => loop.state === 'running')

  const agent = draft.agent ?? agents[0]?.id ?? null
  const showCost = agent !== null && COST_REPORTING_AGENTS.includes(agent) && isLocalHost
  const built = agent ? buildLoopCreateInput(draft, worktreeId, agent, showCost) : null
  const errors = built && 'errors' in built ? built.errors : new Set<FieldError>()
  const update = (patch: Partial<LoopSetupDraft>): void => setDraft((d) => ({ ...d, ...patch }))

  const submit = async (): Promise<void> => {
    if (!built || !('input' in built) || submitting) {
      return
    }
    setSubmitting(true)
    try {
      applyLoopSnapshot(await window.api.loops.create(built.input))
      onOpenChange(false)
    } catch (error) {
      toast.error(translate('fork.loops.setup.createFailed', 'Could not start the loop.'), {
        description: error instanceof Error ? error.message : undefined
      })
      setSubmitting(false)
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      {hasRunningLoop ? (
        <p
          role="status"
          className="rounded-md border border-status-warning-border bg-status-warning-background px-3 py-2 text-xs text-status-warning-foreground"
        >
          {translate(
            'fork.loops.setup.runningLoopWarning',
            'This workspace already has a running loop. A second loop edits the same files at the same time.'
          )}
        </p>
      ) : null}
      <TextField
        id="loop-setup-name"
        label={translate('fork.loops.setup.name', 'Name')}
        placeholder={translate('fork.loops.setup.namePlaceholder', 'Defaults to the prompt')}
        value={draft.name}
        onChange={(name) => update({ name })}
      />
      <SelectField
        label={translate('fork.loops.setup.agent', 'Agent')}
        value={agent ?? ''}
        options={agents.map((entry) => ({ value: entry.id, label: entry.label }))}
        placeholder={translate('fork.loops.setup.noAgents', 'No agents detected')}
        onChange={(value) => update({ agent: isTuiAgent(value) ? value : null })}
      />
      <Field label={translate('fork.loops.setup.preset', 'Run')}>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={draft.preset}
          onValueChange={(value) => {
            const preset = LoopPresetSchema.safeParse(value)
            if (preset.success) {
              update({
                preset: preset.data,
                sessionPolicy: defaultSessionPolicyForPreset(preset.data)
              })
            }
          }}
        >
          {LoopPresetSchema.options.map((preset) => (
            <ToggleGroupItem key={preset} value={preset} aria-label={presetLabel(preset)}>
              <span className="text-xs">{presetLabel(preset)}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Field>
      <PresetFields draft={draft} errors={errors} update={update} />
      <SelectField
        label={translate('fork.loops.setup.session', 'Session')}
        value={draft.sessionPolicy}
        options={[
          {
            value: 'fresh',
            label: translate('fork.loops.setup.sessionFresh', 'Fresh session each iteration')
          },
          {
            value: 'continue',
            label: translate('fork.loops.setup.sessionContinue', 'Continue the same session')
          }
        ]}
        onChange={(value) => {
          const policy = LoopSessionPolicySchema.safeParse(value)
          if (policy.success) {
            update({ sessionPolicy: policy.data })
          }
        }}
      />
      <TextField
        inputMode="numeric"
        id="loop-setup-max-iterations"
        label={translate('fork.loops.setup.maxIterations', 'Maximum iterations')}
        hint={translate('fork.loops.setup.maxIterationsHint', 'Clear to run with no limit.')}
        value={draft.maxIterations}
        error={errors.has('iterations') ? wholeNumberError() : undefined}
        onChange={(maxIterations) => update({ maxIterations })}
      />
      <Collapsible>
        <CollapsibleTrigger variant="row">
          {translate('fork.loops.setup.advanced', 'Advanced')}
          <ChevronDown className="size-4 text-muted-foreground" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <LoopSetupAdvancedFields
            draft={draft}
            errors={errors}
            update={update}
            showCost={showCost}
          />
        </CollapsibleContent>
      </Collapsible>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          {translate('fork.loops.setup.cancel', 'Cancel')}
        </Button>
        <Button type="submit" disabled={!built || 'errors' in built || submitting}>
          {translate('fork.loops.setup.start', 'Start loop')}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** Collects a loop's configuration and starts it through `window.api.loops.create`. */
export function LoopSetupDialog({
  open,
  worktreeId,
  onOpenChange
}: {
  open: boolean
  worktreeId: string
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-hidden sm:max-w-xl">
        <div className="scrollbar-sleek grid max-h-[calc(85vh-3rem)] gap-4 overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{translate('fork.loops.setup.title', 'New loop')}</DialogTitle>
            <DialogDescription>
              {translate(
                'fork.loops.setup.description',
                'Run an agent in this workspace over and over until the work is done.'
              )}
            </DialogDescription>
          </DialogHeader>
          <LoopSetupForm worktreeId={worktreeId} onOpenChange={onOpenChange} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
