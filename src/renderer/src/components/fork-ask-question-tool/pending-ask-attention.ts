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

type PendingAskIndex = {
  tabIds: ReadonlySet<string>
  /** Sorted so a shallow-compared subscription keeps one array identity per snapshot. */
  sortedTabIds: readonly string[]
}

// Why: ask writes replace this map; WeakMap indexes each snapshot once without pinning retired ones.
const indexByQueues = new WeakMap<AskQueues, PendingAskIndex>()

function indexPendingAsks(queues: AskQueues): PendingAskIndex {
  const cached = indexByQueues.get(queues)
  if (cached) {
    return cached
  }
  // Why: every mounted tab and worktree card runs a selector per store tick; scan the map once.
  const tabIds = new Set<string>()
  for (const [paneKey, cards] of Object.entries(queues)) {
    // a pane key is `${tabId}:${paneId}`, and neither half may be empty to attribute the ask
    const separator = paneKey.indexOf(':')
    if (separator <= 0 || separator === paneKey.length - 1) {
      continue
    }
    if (cards.some((card) => !isTerminalAskStatus(card.status))) {
      tabIds.add(paneKey.slice(0, separator))
    }
  }
  const index: PendingAskIndex = { tabIds, sortedTabIds: [...tabIds].sort() }
  indexByQueues.set(queues, index)
  return index
}

/** True while any pane of `tabId` holds a non-terminal ask. */
export function selectTabHasPendingAsk(state: PendingAskAttentionState, tabId: string): boolean {
  const queues = state.pendingAsksByPaneKey
  return queues ? indexPendingAsks(queues).tabIds.has(tabId) : false
}

/** Tab ids holding a non-terminal ask, sorted so a shallow-compared subscription stays stable. */
export function selectPendingAskTabIds(state: PendingAskAttentionState): readonly string[] {
  const queues = state.pendingAsksByPaneKey
  return queues ? indexPendingAsks(queues).sortedTabIds : EMPTY_TAB_IDS
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
  const { tabIds } = indexPendingAsks(queues)
  if (tabIds.size === 0) {
    return false
  }
  return state.tabsByWorktree?.[worktreeId]?.some((tab) => tabIds.has(tab.id)) ?? false
}
