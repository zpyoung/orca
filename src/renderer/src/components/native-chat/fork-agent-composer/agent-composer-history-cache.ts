// Module-level cache for the composer's sent-message history, keyed by the
// same stable pane scope as the draft cache. History lives here instead of
// per-mount React state so recall survives unmount and is shared by every
// host mounted against the same pane: each write notifies subscribers for
// that scope key, which is how a second live mount learns about the first
// mount's push. Mirrors terminal-input-quarantine's subscribe/notify shape.

import { pinScopeCacheKey, setBoundedScopeCacheEntry } from './agent-composer-scope-cache'
import { EMPTY_HISTORY, type HistoryState } from './agent-composer-history'

const historyCache = new Map<string, HistoryState>()

type HistoryCacheListener = (history: HistoryState) => void
const historyCacheListeners = new Map<string, Set<HistoryCacheListener>>()

export function readAgentComposerHistoryCache(scopeKey: string): HistoryState {
  return historyCache.get(scopeKey) ?? EMPTY_HISTORY
}

export function writeAgentComposerHistoryCache(scopeKey: string, history: HistoryState): void {
  // No entries carries no state worth retaining; drop the entry so a stale
  // scope key never resurrects cleared history.
  if (history.entries.length === 0) {
    historyCache.delete(scopeKey)
  } else {
    setBoundedScopeCacheEntry(historyCache, scopeKey, history)
  }
  notifyHistoryCacheListeners(scopeKey, history)
}

/**
 * Subscribes to writes for `scopeKey`. Fires once immediately with the
 * current value, then on every subsequent write, so a mount that subscribes
 * after another mount already wrote cannot miss that entry. Returns an
 * unsubscribe function.
 */
export function subscribeAgentComposerHistoryCache(
  scopeKey: string,
  listener: HistoryCacheListener
): () => void {
  const listeners = historyCacheListeners.get(scopeKey) ?? new Set<HistoryCacheListener>()
  historyCacheListeners.set(scopeKey, listeners)
  listeners.add(listener)
  const unpin = pinScopeCacheKey(scopeKey)
  try {
    listener(readAgentComposerHistoryCache(scopeKey))
  } catch {
    // a subscriber's exception must never stop this subscribe call from completing
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      historyCacheListeners.delete(scopeKey)
    }
    unpin()
  }
}

function notifyHistoryCacheListeners(scopeKey: string, history: HistoryState): void {
  const listeners = historyCacheListeners.get(scopeKey)
  if (!listeners) {
    return
  }
  // snapshot: a listener unsubscribing another mid-dispatch must not skip it
  for (const listener of Array.from(listeners)) {
    try {
      listener(history)
    } catch {
      // a subscriber's exception must never block the other listeners
    }
  }
}

export function clearAgentComposerHistoryCacheForTests(): void {
  historyCache.clear()
  historyCacheListeners.clear()
}
