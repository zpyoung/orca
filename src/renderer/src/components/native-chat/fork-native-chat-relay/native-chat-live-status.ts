// FORK-COPY-OF: src/shared/native-chat/native-chat-live-status.ts
// FORK-COPY-SHA: 1c6ac8c3c4d2c3dec2cb5966d225ca2a0e0471d3
// Reconcile live working state with provider turn boundaries so a dropped final hook cannot leave Stop stuck.

import type { AgentStatusState } from '../../../../../shared/agent-status-types'
import { assembleNativeChatSession, type NativeChatSources } from '../native-chat-session-assembler'
import type {
  AgentType,
  NativeChatSession,
  NativeChatSessionStatus,
  NativeChatTurnLifecycle
} from '../../../../../shared/native-chat-types'
import { LIFECYCLE_CLOCK_SKEW_SLACK_MS } from '../../../../../shared/native-chat-clock-skew'

export type NativeChatLiveMergeInput = {
  sources: NativeChatSources
  sessionId: string | null
  agent: AgentType
  /** Live hook state for the pane, or null when no hook entry exists. */
  hookState: AgentStatusState | null
  /** Epoch ms when the current hook state began, or null when unknown. */
  stateStartedAt?: number | null
  /** Latest provider-authored turn boundary recovered from the transcript. */
  transcriptLifecycle?: NativeChatTurnLifecycle
  /** Claude can finish its lead turn while background children remain active. */
  hookHasWorkingSubagents?: boolean
  /** Before initial snapshot resolution, loading overrides non-working status. */
  loading?: boolean
  /** Set when the initial snapshot failed; forces 'error'. */
  error?: string
}

export type NativeChatLiveMergedSession = NativeChatSession & { hookAwaitingInput: boolean }

/** Errors win; working hooks override loading until their turn ends, with provider lifecycle settling dropped Stop hooks. */
export function mergeNativeChatLiveSession(
  input: NativeChatLiveMergeInput
): NativeChatLiveMergedSession {
  const {
    sources,
    sessionId,
    agent,
    hookState,
    stateStartedAt,
    transcriptLifecycle,
    hookHasWorkingSubagents,
    loading,
    error
  } = input
  const hookAwaitingInput = nativeChatHookAwaitsInput(
    hookState,
    stateStartedAt,
    transcriptLifecycle
  )
  if (error) {
    return {
      ...assembleNativeChatSession({ sources, sessionId, agent, status: 'error', error }),
      hookAwaitingInput
    }
  }

  const status = liveStatusOverride(
    agent,
    hookState,
    sources,
    stateStartedAt,
    transcriptLifecycle,
    hookHasWorkingSubagents ?? false
  )
  // Keep Stop/activity live while loading; view-state selection separately holds empty transcripts on their loading surface.
  if (loading && status !== 'working') {
    return {
      ...assembleNativeChatSession({ sources, sessionId, agent, status: 'loading' }),
      hookAwaitingInput
    }
  }
  return {
    ...assembleNativeChatSession({
      sources,
      sessionId,
      agent,
      ...(status ? { status } : {})
    }),
    hookAwaitingInput
  }
}

/** blocked/waiting needs human input; a transcript terminal marker can clear waits whose interrupt emitted no hook. */
export function nativeChatHookAwaitsInput(
  hookState: AgentStatusState | null,
  stateStartedAt: number | null | undefined,
  transcriptLifecycle: NativeChatTurnLifecycle | undefined
): boolean {
  return (
    (hookState === 'blocked' || hookState === 'waiting') &&
    !lifecycleTerminatesCurrentTurn(transcriptLifecycle, stateStartedAt)
  )
}

/** omp retries its own agent_end hook, so trailing mid-run prose/tool rows cannot stand in for a lost end signal. */
function hookDeliversTurnEnd(agent: AgentType): boolean {
  return agent === 'omp'
}

function liveStatusOverride(
  agent: AgentType,
  hookState: AgentStatusState | null,
  sources: NativeChatSources,
  stateStartedAt: number | null | undefined,
  transcriptLifecycle: NativeChatTurnLifecycle | undefined,
  hookHasWorkingSubagents: boolean
): NativeChatSessionStatus | undefined {
  // Only 'working' drives a live override; blocked/waiting/done leave the
  // derived (ready/empty) status alone so completed turns render normally.
  if (hookState !== 'working') {
    return undefined
  }
  const terminatesCurrentTurn = lifecycleTerminatesCurrentTurn(transcriptLifecycle, stateStartedAt)
  // Explicit interruption ends the aggregate turn even if stale child status still reports work.
  if (terminatesCurrentTurn && transcriptLifecycle?.state === 'interrupted') {
    return undefined
  }
  // Claude lead completion leaves current-epoch children working; callers must exclude older rosters.
  if (hookHasWorkingSubagents) {
    return 'working'
  }
  if (terminatesCurrentTurn) {
    return undefined
  }
  // Use prose recovery only without an explicit working lifecycle; partial live prose must not settle capable providers early.
  if (
    transcriptLifecycle?.state !== 'working' &&
    !hookDeliversTurnEnd(agent) &&
    trailingAssistantPostDates(sources, stateStartedAt)
  ) {
    return undefined
  }
  return 'working'
}

function lifecycleTerminatesCurrentTurn(
  lifecycle: NativeChatTurnLifecycle | undefined,
  stateStartedAt: number | null | undefined
): boolean {
  if (lifecycle?.state !== 'completed' && lifecycle?.state !== 'interrupted') {
    return false
  }
  // Missing timestamps are valid; latest lifecycle wins because a newer user generation would have replaced it with working.
  if (stateStartedAt == null || lifecycle.timestamp == null) {
    return true
  }
  if (lifecycle.timestamp >= stateStartedAt) {
    return true
  }
  // Apply clock slack only to real epoch timestamps; logical clocks retain strict ordering.
  if (lifecycle.timestamp > 1e11 && stateStartedAt > 1e11) {
    return lifecycle.timestamp + LIFECYCLE_CLOCK_SKEW_SLACK_MS >= stateStartedAt
  }
  return false
}

function trailingAssistantPostDates(
  sources: NativeChatSources,
  stateStartedAt: number | null | undefined
): boolean {
  if (stateStartedAt == null) {
    return false
  }
  const last = (sources.transcript ?? []).at(-1)
  return last?.role === 'assistant' && last.timestamp != null && last.timestamp >= stateStartedAt
}
