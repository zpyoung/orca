import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { HistoryState } from './agent-composer-history'
import {
  readAgentComposerHistoryCache,
  writeAgentComposerHistoryCache
} from './agent-composer-history-cache'

/**
 * Composer sent-message history backed by the scope cache so recall survives
 * the composer unmounting and is shared by every host mounted against the same
 * pane. `scopeKey` is the stable pane key also used for the draft cache; when
 * it changes (the composer is reused for a different pane) history reloads.
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

  const setHistory = useCallback<Dispatch<SetStateAction<HistoryState>>>(
    (next) => {
      setHistoryState((previous) => {
        const resolved =
          typeof next === 'function' ? (next as (p: HistoryState) => HistoryState)(previous) : next
        writeAgentComposerHistoryCache(scopeKey, resolved)
        return resolved
      })
    },
    [scopeKey]
  )

  return { history, setHistory }
}
