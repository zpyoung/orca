import { resolvePaneAgentActivity } from '@/lib/pane-agent-evidence'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'

export type HandoffDeliveryOutcome = 'delivered' | 'not-delivered' | 'unobservable'

export type HandoffDeliveryEvidenceState = Pick<
  AppState,
  'agentStatusByPaneKey' | 'ptyIdsByTabId' | 'runtimePaneTitlesByTabId' | 'tabsByWorktree'
>

export type ResolveHandoffDeliveryEvidenceArgs = {
  tabId: string | null
  launchedAtMs: number
  deliveryReported?: boolean
  state?: HandoffDeliveryEvidenceState
  observedAtMs?: number
}

/** Resolve delivery only from an upstream report or positive pane activity evidence. */
export function resolveHandoffDeliveryEvidence({
  tabId,
  launchedAtMs,
  deliveryReported,
  state = useAppStore.getState(),
  observedAtMs = Date.now()
}: ResolveHandoffDeliveryEvidenceArgs): HandoffDeliveryOutcome {
  if (deliveryReported === true) {
    return 'delivered'
  }
  if (!tabId) {
    return 'unobservable'
  }

  const entries = getTabEntries(state.agentStatusByPaneKey, tabId)
  if (entries.some((entry) => hasTurnStarted(entry, launchedAtMs))) {
    return 'delivered'
  }
  if (deliveryReported !== false) {
    return 'unobservable'
  }

  const hasLivePty = (state.ptyIdsByTabId[tabId]?.length ?? 0) > 0
  const liveTitles = getTabLiveTitles(state, tabId)
  const evidence = entries.map((entry, index) =>
    resolvePaneAgentActivity({
      explicitEntry: entry,
      liveTitle: liveTitles[index] ?? entry.terminalTitle ?? liveTitles[0] ?? null,
      hasLivePty,
      now: observedAtMs
    })
  )

  if (entries.length === 0) {
    evidence.push(
      ...liveTitles.map((liveTitle) =>
        resolvePaneAgentActivity({
          explicitEntry: undefined,
          liveTitle,
          hasLivePty,
          now: observedAtMs
        })
      )
    )
  }

  return evidence.length > 0 && evidence.every(isPositiveIdleEvidence)
    ? 'not-delivered'
    : 'unobservable'
}

function getTabEntries(
  entries: AppState['agentStatusByPaneKey'],
  tabId: string
): AgentStatusEntry[] {
  return Object.entries(entries)
    .filter(([paneKey]) => parsePaneKey(paneKey)?.tabId === tabId)
    .map(([, entry]) => entry)
}

function hasTurnStarted(entry: AgentStatusEntry, launchedAtMs: number): boolean {
  return (
    (entry.state === 'working' && entry.stateStartedAt >= launchedAtMs) ||
    entry.stateHistory.some(
      (historicalState) =>
        historicalState.state === 'working' && historicalState.startedAt >= launchedAtMs
    )
  )
}

function getTabLiveTitles(state: HandoffDeliveryEvidenceState, tabId: string): string[] {
  const paneTitles = Object.values(state.runtimePaneTitlesByTabId[tabId] ?? {})
  if (paneTitles.length > 0) {
    return paneTitles
  }
  for (const tabs of Object.values(state.tabsByWorktree)) {
    const tab = tabs.find((candidate) => candidate.id === tabId)
    if (tab) {
      return [tab.title]
    }
  }
  return []
}

function isPositiveIdleEvidence(decision: ReturnType<typeof resolvePaneAgentActivity>): boolean {
  if (decision.source === 'none' || decision.livePtyRequired) {
    return false
  }
  if (decision.titleStatus && decision.titleStatus !== 'idle') {
    return false
  }
  return decision.source === 'hook' && decision.hookState === 'done'
}
