import {
  isTerminalAskStatus,
  type AskStatus
} from '../../../../shared/fork-ask-question-tool/ask-answer-envelope'

type AskQueues = Record<string, readonly { status: AskStatus }[]>

const EMPTY_TAB_IDS: readonly string[] = []

type PendingAskAttentionState = {
  pendingAsksByPaneKey?: AskQueues
  tabsByWorktree?: Record<string, readonly { id: string }[]>
}

function tabHasPendingAsk(queues: AskQueues, paneKeys: string[], tabId: string): boolean {
  const prefix = `${tabId}:`
  // Prefix matching also covers legacy numeric pane IDs.
  return paneKeys.some(
    (key) =>
      key.startsWith(prefix) &&
      key.length > prefix.length &&
      queues[key].some((card) => !isTerminalAskStatus(card.status))
  )
}

/** True while any pane of `tabId` holds a non-terminal ask. */
export function selectTabHasPendingAsk(state: PendingAskAttentionState, tabId: string): boolean {
  const queues = state.pendingAsksByPaneKey
  if (!queues) {
    return false
  }
  const paneKeys = Object.keys(queues)
  return paneKeys.length > 0 && tabHasPendingAsk(queues, paneKeys, tabId)
}

/** Tab ids holding a non-terminal ask, sorted so a shallow-compared subscription stays stable. */
export function selectPendingAskTabIds(state: PendingAskAttentionState): readonly string[] {
  const queues = state.pendingAsksByPaneKey
  if (!queues) {
    return EMPTY_TAB_IDS
  }
  const tabIds = new Set<string>()
  for (const [key, cards] of Object.entries(queues)) {
    // inverse of the prefix match above: a pane key is `${tabId}:${paneId}`
    const separator = key.lastIndexOf(':')
    if (separator > 0 && cards.some((card) => !isTerminalAskStatus(card.status))) {
      tabIds.add(key.slice(0, separator))
    }
  }
  return [...tabIds].sort()
}

/** True while any tab of `worktreeId` holds a non-terminal ask. */
export function selectWorktreeHasPendingAsk(
  state: PendingAskAttentionState,
  worktreeId: string
): boolean {
  const queues = state.pendingAsksByPaneKey
  if (!queues) {
    return false
  }
  // why: this runs per worktree card on every store tick; enumerate the queue map once
  const paneKeys = Object.keys(queues)
  if (paneKeys.length === 0) {
    return false
  }
  return (
    state.tabsByWorktree?.[worktreeId]?.some((tab) => tabHasPendingAsk(queues, paneKeys, tab.id)) ??
    false
  )
}
