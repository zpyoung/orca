import { translate } from '@/i18n/i18n'
import { getAgentCatalog, type AgentCatalogEntry } from '@/lib/agent-catalog'
import type { HandoffPreviewPhase } from '@/lib/fork-session-handoff/handoff-preview-detach'
import {
  composeHandoffBrief,
  type HandoffBriefInputs
} from '@/lib/fork-session-handoff/handoff-brief-composer'
import type { SecretScanHit } from '@/lib/fork-session-handoff/handoff-secret-scan'
import type { HandoffTranscriptReachability } from '@/lib/fork-session-handoff/handoff-transcript-reachability'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { LaunchSource } from '../../../../../shared/telemetry-events'
import {
  getHandoffAnchorRepoId,
  resolveHandoffTarget,
  type HandoffTargetResolution
} from '@/lib/fork-session-handoff/handoff-target-resolution'
import type {
  ForkSessionHandoffSettings,
  ForkSessionHandoffTemplate
} from '../../../../../shared/fork-session-handoff/handoff-settings-types'
import type { TuiAgent } from '../../../../../shared/tui-agent'
import type { HandoffDialogWarning } from './HandoffWarningsBanner'

export type HandoffDialogStoreInputs = Pick<
  AppState,
  | 'activeWorkspaceExecutionHostId'
  | 'activeWorkspaceKey'
  | 'activeWorktreeId'
  | 'detectedWorktreesByRepo'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'repos'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
  | 'settings'
  | 'worktreesByRepo'
>

export function selectHandoffDialogStoreInputs(state: AppState): HandoffDialogStoreInputs {
  return {
    activeWorkspaceExecutionHostId: state.activeWorkspaceExecutionHostId,
    activeWorkspaceKey: state.activeWorkspaceKey,
    activeWorktreeId: state.activeWorktreeId,
    detectedWorktreesByRepo: state.detectedWorktreesByRepo,
    folderWorkspaces: state.folderWorkspaces,
    projectGroups: state.projectGroups,
    repos: state.repos,
    restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey,
    settings: state.settings,
    worktreesByRepo: state.worktreesByRepo
  }
}

function getDefaultHandoffTemplates(): ForkSessionHandoffTemplate[] {
  return [
    {
      id: 'continue-implementation',
      name: translate(
        'components.agentSessionContinuation.forkSessionHandoff.templateContinueImplementation',
        'Continue implementation'
      ),
      body: 'Continue the implementation from the stopping point. Verify existing changes before making new ones.'
    },
    {
      id: 'review-completed-work',
      name: translate(
        'components.agentSessionContinuation.forkSessionHandoff.templateReviewCompletedWork',
        'Review what was done'
      ),
      body: 'Review the work already completed. Focus on correctness, regressions, and missing tests before changing code.'
    },
    {
      id: 'debug-failure',
      name: translate(
        'components.agentSessionContinuation.forkSessionHandoff.templateDebugFailure',
        'Debug the failure'
      ),
      body: 'Reproduce and diagnose the latest failure. Use the available status and changed paths to isolate the cause.'
    }
  ]
}

export function chooseHandoffAgent(
  available: TuiAgent[],
  ...preferred: unknown[]
): TuiAgent | null {
  return (
    preferred.find(
      (agent): agent is TuiAgent =>
        typeof agent === 'string' && available.includes(agent as TuiAgent)
    ) ??
    available[0] ??
    null
  )
}

export function buildHandoffWarnings(args: {
  sourceBusy: boolean
  hostChanged: boolean
  secretHits: SecretScanHit[]
  transcriptReachability: HandoffTranscriptReachability
  compositionWarnings: string[]
  previewPhase: HandoffPreviewPhase
  operationErrors: string[]
}): HandoffDialogWarning[] {
  const warnings: HandoffDialogWarning[] = []
  if (args.sourceBusy) {
    warnings.push({ kind: 'source-busy' })
  }
  if (args.hostChanged) {
    warnings.push({ kind: 'host-changed' })
  }
  if (args.secretHits.length) {
    warnings.push({ kind: 'secret-hits', hits: args.secretHits })
  }
  if (args.transcriptReachability === 'unreachable') {
    warnings.push({ kind: 'transcript-unreachable' })
  }
  for (const code of args.compositionWarnings) {
    if (code === 'no-transcript-context' || code === 'diff-truncated' || code === 'no-context') {
      warnings.push({ kind: code })
    }
  }
  if (args.previewPhase.phase === 'detached' && args.previewPhase.staleReasons.length) {
    warnings.push({ kind: 'stale-preview', reasons: args.previewPhase.staleReasons })
  }
  for (const message of args.operationErrors) {
    if (message) {
      warnings.push({ kind: 'operation-error', message })
    }
  }
  return warnings
}

/** Explain why Start refreshed the preview instead of sending it. */
export function handoffCaptureChangedNotice(): string {
  return translate(
    'components.agentSessionContinuation.forkSessionHandoff.captureChanged',
    'The source session changed. The preview was refreshed — review it, then start again.'
  )
}

export function handoffLaunchError(reason: 'agent-unavailable' | 'launch-failed'): string {
  return reason === 'agent-unavailable'
    ? translate(
        'components.agentSessionContinuation.forkSessionHandoff.agentUnavailable',
        'The selected Agent is no longer available on the target host.'
      )
    : translate(
        'components.agentSessionContinuation.forkSessionHandoff.launchFailed',
        'Could not start the new Agent session. Your handoff is unchanged.'
      )
}

async function createInlineHandoffWorktree(args: {
  anchorWorktreeId: string
  name: string
  baseBranch: string
  launchSource: LaunchSource
}): Promise<string> {
  const state = useAppStore.getState()
  const repoId = getHandoffAnchorRepoId(state, args.anchorWorktreeId)
  if (!repoId) {
    throw new Error(
      translate(
        'components.agentSessionContinuation.forkSessionHandoff.createUnavailable',
        'No Git repository is available for worktree creation.'
      )
    )
  }
  const telemetrySource =
    args.launchSource === 'terminal_context_menu' ? 'terminal_context_menu' : 'sidebar'
  const result = await state.createWorktree(
    repoId,
    args.name.trim(),
    args.baseBranch.trim() || undefined,
    undefined,
    undefined,
    telemetrySource
  )
  return result.worktree.id
}

function resolveCreatedHandoffTarget(worktreeId: string): HandoffTargetResolution {
  const target = resolveHandoffTarget(useAppStore.getState(), worktreeId)
  if (!target) {
    throw new Error(
      translate(
        'components.agentSessionContinuation.forkSessionHandoff.createdTargetUnavailable',
        'The new worktree could not be resolved.'
      )
    )
  }
  return target
}

export async function createAndSelectInlineHandoffTarget(args: {
  anchorWorktreeId: string
  name: string
  baseBranch: string
  launchSource: LaunchSource
  onCreated: (worktreeId: string) => void
}): Promise<HandoffTargetResolution> {
  const worktreeId = await createInlineHandoffWorktree(args)
  args.onCreated(worktreeId)
  return resolveCreatedHandoffTarget(worktreeId)
}

export type HandoffStartBodyResolution =
  | { status: 'ready'; body: string }
  | { status: 'capture-changed'; body: string; latestCapture: string | null }

export function resolveHandoffBodyForStart(args: {
  inputs: HandoffBriefInputs
  previewPhase: HandoffPreviewPhase
  editedBody: string
  previewedBody: string
  latestCapture: string | null
}): HandoffStartBodyResolution {
  if (args.previewPhase.phase === 'detached') {
    return { status: 'ready', body: args.editedBody }
  }
  const body = composeHandoffBrief({
    ...args.inputs,
    source: {
      ...args.inputs.source,
      capturedText: args.latestCapture ?? args.inputs.source.capturedText
    },
    inlinedCapture: args.inputs.transcriptUsableOnTarget
      ? null
      : (args.latestCapture ?? args.inputs.inlinedCapture)
  }).editableBody
  return body === args.previewedBody
    ? { status: 'ready', body }
    : { status: 'capture-changed', body, latestCapture: args.latestCapture }
}

export function isHandoffStartDisabled(args: {
  starting: boolean
  detectingAgents: boolean
  selectedAgent: TuiAgent | null
  target: HandoffTargetResolution | null
  noContext: boolean
  transcriptReachabilityLoading: boolean
  repoStateLoading: boolean
  repoStateIncluded: boolean
  createMode: boolean
  createName: string
}): boolean {
  return (
    args.starting ||
    args.detectingAgents ||
    !args.selectedAgent ||
    !args.target ||
    args.noContext ||
    args.transcriptReachabilityLoading ||
    (args.repoStateIncluded && args.repoStateLoading) ||
    (args.createMode && !args.createName.trim())
  )
}

export function isHandoffContextEmpty(args: {
  compositionWarnings: string[]
  previewPhase: HandoffPreviewPhase
  editedBody: string
}): boolean {
  return args.previewPhase.phase === 'detached'
    ? !args.editedBody.trim()
    : args.compositionWarnings.includes('no-context')
}

export function visibleHandoffCompositionWarnings(args: {
  compositionWarnings: string[]
  previewPhase: HandoffPreviewPhase
  editedBody: string
}): string[] {
  return args.compositionWarnings.filter(
    (code) =>
      code !== 'no-context' || args.previewPhase.phase === 'attached' || !args.editedBody.trim()
  )
}

export async function persistHandoffPreferencesBestEffort(args: {
  update: (settings: { forkSessionHandoff: ForkSessionHandoffSettings }) => Promise<void>
  settings: ForkSessionHandoffSettings
}): Promise<void> {
  try {
    await args.update({ forkSessionHandoff: args.settings })
  } catch {}
}

export function getHandoffAgentCatalog(detectedAgents: TuiAgent[]): AgentCatalogEntry[] {
  return getAgentCatalog().filter((entry) => detectedAgents.includes(entry.id))
}

export function getHandoffContextDisabledReason(
  reachability: HandoffTranscriptReachability
): string | null {
  return reachability === 'usable'
    ? null
    : translate(
        'components.agentSessionContinuation.forkSessionHandoff.contextUnavailable',
        'A full saved transcript is not reachable on this target. Focused context will be used.'
      )
}

export function getHandoffTemplates(
  configured: ForkSessionHandoffTemplate[] | undefined
): ForkSessionHandoffTemplate[] {
  return configured !== undefined ? configured : getDefaultHandoffTemplates()
}
