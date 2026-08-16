import { useCallback, useEffect, useRef, useState } from 'react'
import {
  readAgentComposerDraftCache,
  subscribeAgentComposerDraftCache,
  writeAgentComposerDraftCache
} from './agent-composer-draft-cache'

/**
 * Composer draft state backed by the scope cache so a typed-but-unsent message
 * survives the composer unmounting on a TUI/GUI toggle. `scopeKey` is the stable
 * pane key also used for image attachments; when it changes (the composer is
 * reused for a different pane) the cached draft is reloaded. Every live mount
 * for a scope key subscribes to the cache, so a write from one mount is
 * reflected in every other concurrently-mounted host on that pane.
 */
export function useAgentComposerDraft(scopeKey: string): {
  draft: string
  setDraft: (next: string | ((previous: string) => string)) => void
} {
  const [draft, setDraftState] = useState(() => readAgentComposerDraftCache(scopeKey))

  // Reload the cached draft when reused for a different pane (scope change),
  // adjusting state during render rather than in an effect so the restored draft
  // is visible on the first paint after the switch.
  const lastScopeKey = useRef(scopeKey)
  if (lastScopeKey.current !== scopeKey) {
    lastScopeKey.current = scopeKey
    setDraftState(readAgentComposerDraftCache(scopeKey))
  }

  useEffect(() => subscribeAgentComposerDraftCache(scopeKey, setDraftState), [scopeKey])

  // Persist every mutation through the cache. Accepts the same value/updater
  // forms as a useState setter so call sites are drop-in.
  const setDraft = useCallback(
    (next: string | ((previous: string) => string)) => {
      // resolve against the cache's current value, not this mount's possibly-stale state
      const previous = readAgentComposerDraftCache(scopeKey)
      const resolved = typeof next === 'function' ? next(previous) : next
      writeAgentComposerDraftCache(scopeKey, resolved)
    },
    [scopeKey]
  )

  return { draft, setDraft }
}
