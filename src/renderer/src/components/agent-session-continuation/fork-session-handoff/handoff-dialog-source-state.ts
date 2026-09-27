import { resolveAgentRowPaneLiveTitle } from '@/components/dashboard/agent-row-pane-live-title'
import type {
  AgentSessionContinuationRequest,
  AgentSessionContinuationSource
} from '@/lib/agent-session-continuation'
import { resolvePaneAgentActivity } from '@/lib/pane-agent-evidence'
import type { AppState } from '@/store/types'
import type { LineageEndpointIdentity } from '../../../../../shared/fork-session-handoff/session-lineage-types'
import { parsePaneKey } from '../../../../../shared/stable-pane-id'
import type { HandoffDraftSourceIdentity } from './handoff-draft-preservation'
import type { ForkSessionHandoffSource } from './prepare-handoff-from-pane'

export type HandoffSourceStoreInputs = Pick<
  AppState,
  | 'agentStatusByPaneKey'
  | 'agentStatusEpoch'
  | 'ptyIdsByTabId'
  | 'runtimePaneTitlesByTabId'
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
>

export function selectHandoffSourceStoreInputs(state: AppState): HandoffSourceStoreInputs {
  return {
    agentStatusByPaneKey: state.agentStatusByPaneKey,
    agentStatusEpoch: state.agentStatusEpoch,
    ptyIdsByTabId: state.ptyIdsByTabId,
    runtimePaneTitlesByTabId: state.runtimePaneTitlesByTabId,
    tabsByWorktree: state.tabsByWorktree,
    terminalLayoutsByTabId: state.terminalLayoutsByTabId
  }
}

export function getHandoffDraftIdentity(
  source: ForkSessionHandoffSource | undefined
): HandoffDraftSourceIdentity {
  return {
    sourcePaneKey: source?.sourcePaneKey ?? null,
    vaultAgent: source?.vaultAgent ?? null,
    vaultSessionId: source?.vaultSessionId ?? null
  }
}

export function resolveHandoffSourceActivity(
  source: ForkSessionHandoffSource | undefined,
  store: HandoffSourceStoreInputs
): { available: boolean; busy: boolean; providerSessionId: string | null } {
  const sourcePaneKey = source?.sourcePaneKey ?? null
  const parsed = sourcePaneKey ? parsePaneKey(sourcePaneKey) : null
  if (!parsed) {
    return { available: false, busy: false, providerSessionId: null }
  }
  const layout = store.terminalLayoutsByTabId[parsed.tabId]
  const sourcePtyId = layout?.ptyIdsByLeafId?.[parsed.leafId]
  const hasLivePty = Boolean(
    sourcePtyId && store.ptyIdsByTabId[parsed.tabId]?.includes(sourcePtyId)
  )
  const tab = Object.values(store.tabsByWorktree)
    .flat()
    .find((entry) => entry.id === parsed.tabId)
  const paneTitle = resolveAgentRowPaneLiveTitle(
    layout,
    store.runtimePaneTitlesByTabId[parsed.tabId],
    parsed.leafId
  )
  const entry = store.agentStatusByPaneKey[sourcePaneKey!]
  const decision = resolvePaneAgentActivity({
    explicitEntry: entry,
    liveTitle: paneTitle === undefined ? (tab?.title ?? null) : paneTitle,
    hasLivePty,
    now: Date.now()
  })
  const available = hasLivePty && decision.source !== 'none' && !decision.livePtyRequired
  const busy =
    available &&
    (decision.source === 'hook'
      ? decision.hookState === 'working'
      : decision.titleStatus === 'working')
  return { available, busy, providerSessionId: entry?.providerSession?.id ?? null }
}

export function captureHandoffSource(
  forkSource: ForkSessionHandoffSource | undefined,
  source: AgentSessionContinuationSource | null
): string | null {
  try {
    return forkSource?.capturePaneScrollback?.() || source?.capturedText || null
  } catch {
    return source?.capturedText || null
  }
}

export function buildHandoffParentIdentity(
  request: AgentSessionContinuationRequest,
  forkSource: ForkSessionHandoffSource | undefined,
  providerSessionId: string | null,
  // Why the sent brief's path wins: lineage rows match a Vault session by file
  // identity, so recording a stale reported path would never pair with one.
  sentTranscriptPath: string | null = null
): LineageEndpointIdentity {
  return {
    paneKey: forkSource?.sourcePaneKey ?? null,
    agent: forkSource?.vaultAgent ?? request.source.sourceAgent,
    providerSessionId: forkSource?.vaultSessionId ?? providerSessionId,
    transcriptPath: sentTranscriptPath ?? request.source.transcriptPath ?? null,
    worktreeId: forkSource?.sourceWorktreeId ?? null,
    title: request.source.sourceTitle ?? null
  }
}
