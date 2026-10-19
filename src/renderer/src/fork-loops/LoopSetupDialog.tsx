import { useMemo, useRef, useState } from 'react'
import { Repeat } from 'lucide-react'
import { toast } from 'sonner'
import { closeUnfocusedMonacoFindOrPreventDialogDismiss } from '@/components/editor/monaco-find-widget'
import { getAutomationPromptEditorRoot } from '@/components/automations/AutomationEditorPromptEditor'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useDetectedAgents, type AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import { translate } from '@/i18n/i18n'
import { getAgentCatalog, type AgentCatalogEntry } from '@/lib/agent-catalog'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/resolved-worktree-execution-host'
import { useAppStore } from '@/store'
import {
  defaultSessionPolicyForPreset,
  LoopCreateInputSchema,
  type LoopConfig,
  type LoopCreateInput
} from '../../../shared/fork-loops/loop-types'
import { parseExecutionHostId } from '../../../shared/execution-host'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  DEFAULT_DISABLED_TUI_AGENTS,
  filterEnabledTuiAgents
} from '../../../shared/tui-agent-selection'
import { useIsFolderWorkspace } from './loop-config-fields'
import { selectLoopsForWorktree } from './loops-slice'
import type { FieldError, LoopSetupDraft } from './LoopSetupAdvancedFields'
import { LoopSetupPromptPane } from './LoopSetupPromptPane'
import { LoopSetupSettingsSidebar, presetLabel } from './LoopSetupSettingsSidebar'

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
  queueItems: [],
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
  showCost: boolean,
  allowCheckpointCommits: boolean
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
    checkpointCommits: allowCheckpointCommits && draft.checkpointCommits,
    askBeforeNext: draft.askBeforeNext,
    resumeAtLimitReset: draft.resumeAtLimitReset
  }
  const input: LoopCreateInput = {
    worktreeId,
    name: autoName(draft),
    agent,
    preset: draft.preset,
    config,
    ...(draft.preset === 'queue'
      ? { queueItems: draft.queueItems.map((item) => item.body.trim()) }
      : {})
  }
  const errors = new Set<FieldError>()
  if (draft.preset !== 'queue' && draft.prompt.trim() === '') {
    errors.add('prompt')
  }
  if (draft.preset === 'queue') {
    if (draft.queueItems.length === 0) {
      errors.add('queue')
    } else if (draft.queueItems.some((item) => item.body.trim() === '')) {
      errors.add('queueItem')
    }
  }
  for (const issue of LoopCreateInputSchema.safeParse(input).error?.issues ?? []) {
    const field = FIELD_ERROR_BY_PATH[issue.path.join('.')]
    if (field) {
      errors.add(field)
    }
  }
  return errors.size > 0 ? { errors } : { input }
}

function detectionTargetForHost(
  hostId: string | null,
  worktreeId: string
): AgentDetectionTarget | undefined {
  const host = parseExecutionHostId(hostId)
  if (!host) {
    return undefined
  }
  if (host.kind === 'ssh') {
    return { kind: 'ssh', connectionId: host.targetId }
  }
  if (host.kind === 'runtime') {
    return { kind: 'runtime', environmentId: host.environmentId, worktreeId }
  }
  return { kind: 'local' }
}

function useSelectableAgents(worktreeId: string): {
  agents: AgentCatalogEntry[]
  isLocalHost: boolean
} {
  // routes by the worktree's own host; the shared hook falls back to the Active Server setting
  const hostId = useAppStore((s) => getResolvedExecutionHostIdForWorktree(s, worktreeId))
  const target = useMemo(() => detectionTargetForHost(hostId, worktreeId), [hostId, worktreeId])
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
  const defaultAgent = useAppStore((s) => s.settings?.defaultTuiAgent ?? null)
  const loops = useAppStore((s) => selectLoopsForWorktree(s, worktreeId))
  const applyLoopSnapshot = useAppStore((s) => s.applyLoopSnapshot)
  const hasRunningLoop = loops.some((loop) => loop.state === 'running')

  const isFolderWorkspace = useIsFolderWorkspace(worktreeId)

  const agent = draft.agent ?? agents[0]?.id ?? null
  const showCost = agent !== null && COST_REPORTING_AGENTS.includes(agent) && isLocalHost
  const built = agent
    ? buildLoopCreateInput(draft, worktreeId, agent, showCost, !isFolderWorkspace)
    : null
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
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div className="flex min-h-0 flex-1 flex-row">
        <LoopSetupPromptPane
          draft={draft}
          errors={errors}
          update={update}
          namePlaceholder={autoName(draft)}
          warning={
            hasRunningLoop
              ? translate(
                  'fork.loops.setup.runningLoopWarning',
                  'This workspace already has a running loop. A second loop edits the same files at the same time.'
                )
              : null
          }
          onDismiss={() => onOpenChange(false)}
        />
        <LoopSetupSettingsSidebar
          draft={draft}
          errors={errors}
          update={update}
          agents={agents}
          agent={agent}
          defaultAgent={defaultAgent}
          showCost={showCost}
          showCheckpointCommits={!isFolderWorkspace}
          onAgentChange={(next) => update({ agent: next })}
        />
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border/50 px-5 py-3">
        <p className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <Repeat className="size-3.5 shrink-0" />
          <span className="truncate">
            {translate(
              'fork.loops.setup.description',
              'Run an agent in this workspace over and over until the work is done.'
            )}
          </span>
        </p>
        <div className="flex shrink-0 justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {translate('fork.loops.setup.cancel', 'Cancel')}
          </Button>
          <Button type="submit" disabled={!built || 'errors' in built || submitting}>
            {translate('fork.loops.setup.start', 'Start loop')}
          </Button>
        </div>
      </div>
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
  const dialogContentRef = useRef<HTMLDivElement>(null)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={dialogContentRef}
        aria-describedby={undefined}
        className="h-[min(880px,90vh)] w-[min(1080px,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] grid-rows-[minmax(0,1fr)] overflow-hidden sm:max-w-[1080px]"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          if (
            closeUnfocusedMonacoFindOrPreventDialogDismiss({
              root: getAutomationPromptEditorRoot(dialogContentRef.current),
              eventTarget: event.target
            })
          ) {
            event.preventDefault()
          }
        }}
      >
        {/* why: DialogContent's padding is lint-locked, so the edge-to-edge panes cancel it here */}
        <div className="-m-6 flex min-h-0 flex-col">
          <div className="flex items-center border-b border-border/50 px-5 py-2.5 pr-12">
            <DialogTitle>{translate('fork.loops.setup.title', 'New loop')}</DialogTitle>
          </div>
          <LoopSetupForm worktreeId={worktreeId} onOpenChange={onOpenChange} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
