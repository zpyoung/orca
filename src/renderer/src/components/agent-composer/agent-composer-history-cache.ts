// Module-level cache for the composer's sent-message history, keyed by the
// same stable pane scope as the draft cache. History used to live as per-mount
// React state, so it was lost on unmount and never shared between two hosts
// mounted against the same pane; this cache makes ArrowUp recall survive both.

import { setBoundedScopeCacheEntry } from './agent-composer-scope-cache'
import { EMPTY_HISTORY, type HistoryState } from './agent-composer-history'

const historyCache = new Map<string, HistoryState>()

export function readAgentComposerHistoryCache(scopeKey: string): HistoryState {
  return historyCache.get(scopeKey) ?? EMPTY_HISTORY
}

export function writeAgentComposerHistoryCache(scopeKey: string, history: HistoryState): void {
  // No entries carries no state worth retaining; drop the entry so a stale
  // scope key never resurrects cleared history.
  if (history.entries.length === 0) {
    historyCache.delete(scopeKey)
    return
  }
  setBoundedScopeCacheEntry(historyCache, scopeKey, history)
}

export function clearAgentComposerHistoryCacheForTests(): void {
  historyCache.clear()
}
