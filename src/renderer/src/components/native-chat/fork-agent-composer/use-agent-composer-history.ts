import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { HistoryState } from './agent-composer-history'
import {
  readAgentComposerHistoryCache,
  subscribeAgentComposerHistoryCache,
  writeAgentComposerHistoryCache
} from './agent-composer-history-cache'

/**
 * Composer sent-message history backed by the scope cache so recall survives
 * the composer unmounting and is shared by every host mounted against the same
 * pane. `scopeKey` is the stable pane key also used for the draft cache; when
 * it changes (the composer is reused for a different pane) history reloads.
 * Every live mount for a scope key subscribes to the cache, so a push from one
 * mount is reflected in every other concurrently-mounted host on that pane.
 */
export function useAgentComposerHistory(scopeKey: string): {
  history: HistoryState
  setHistory: Dispatch<SetStateAction<HistoryState>>
} {
  const [history, setHistoryState] = useState(() => readAgentComposerHistoryCache(scopeKey))

  const lastScopeKey = useRef(scopeKey)
  if (lastScopeKey.current !== scopeKey) {
    lastScopeKey.current = scopeKey
    setHistoryState(readAgentComposerHistoryCache(scopeKey))
  }

  useEffect(() => subscribeAgentComposerHistoryCache(scopeKey, setHistoryState), [scopeKey])

  const setHistory = useCallback<Dispatch<SetStateAction<HistoryState>>>(
    (next) => {
      // Resolves against the cache's current value rather than this mount's
      // local state, so a concurrent mount's write is never clobbered.
      const previous = readAgentComposerHistoryCache(scopeKey)
      const resolved =
        typeof next === 'function' ? (next as (p: HistoryState) => HistoryState)(previous) : next
      writeAgentComposerHistoryCache(scopeKey, resolved)
    },
    [scopeKey]
  )

  return { history, setHistory }
}
