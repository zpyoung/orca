// Module-level cache for the composer's sent-message history, keyed by the
// same stable pane scope as the draft cache. History lives here instead of
// per-mount React state so recall survives unmount and is shared by every
// host mounted against the same pane: each write notifies subscribers for
// that scope key, which is how a second live mount learns about the first
// mount's push. Mirrors terminal-input-quarantine's subscribe/notify shape.

import { EMPTY_HISTORY, type HistoryState } from './agent-composer-history'
import { createSubscribableScopeCache } from './agent-composer-scope-cache'

const historyCache = createSubscribableScopeCache<HistoryState>({
  createEmptyValue: () => EMPTY_HISTORY,
  isEmpty: (history) => history.entries.length === 0
})

export const readAgentComposerHistoryCache = historyCache.read
export const writeAgentComposerHistoryCache = historyCache.write

/**
 * Subscribes to writes for `scopeKey`. Fires once immediately with the
 * current value, then on every subsequent write, so a mount that subscribes
 * after another mount already wrote cannot miss that entry. Returns an
 * unsubscribe function.
 */
export const subscribeAgentComposerHistoryCache = historyCache.subscribe

export const clearAgentComposerHistoryCacheForTests = historyCache.clearForTests
