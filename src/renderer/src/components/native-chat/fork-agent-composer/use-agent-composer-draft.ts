import { useCallback, useEffect, useRef, useState } from 'react'
import {
  appendNativeChatDraftText,
  readNativeChatDraftCache,
  subscribeToNativeChatDraftAppend
} from '../native-chat-draft-cache'
import {
  adoptNativeChatDraftAppends,
  readAgentComposerDraftCache,
  subscribeAgentComposerDraftCache,
  writeAgentComposerDraftCache
} from './agent-composer-draft-cache'

const NEVER_COMPOSING = (): boolean => false

/**
 * Composer draft state backed by the scope cache so a typed-but-unsent message
 * survives the composer unmounting on a TUI/GUI toggle. `scopeKey` is the stable
 * pane key also used for image attachments; when it changes (the composer is
 * reused for a different pane) the cached draft is reloaded. Every live mount
 * for a scope key subscribes to the cache, so a write from one mount is
 * reflected in every other concurrently-mounted host on that pane.
 *
 * Text appended from outside the composer (a withdrawn structured send) is shown
 * after the draft; during an IME composition it is held until `flushDraftAppends`.
 */
export function useAgentComposerDraft(
  scopeKey: string,
  isComposing: () => boolean = NEVER_COMPOSING
): {
  draft: string
  setDraft: (next: string | ((previous: string) => string)) => void
  /** Shows text appended during an IME composition, which owns the field until it settles. */
  flushDraftAppends: () => void
} {
  const [draft, setDraftState] = useState(() => readAgentComposerDraftCache(scopeKey))
  // Held out of the cache while composing: the composition's own writes would erase it.
  const pendingAppendRef = useRef<{ scopeKey: string; text: string } | null>(null)

  // Reload the cached draft when reused for a different pane (scope change),
  // adjusting state during render rather than in an effect so the restored draft
  // is visible on the first paint after the switch.
  const lastScopeKey = useRef(scopeKey)
  if (lastScopeKey.current !== scopeKey) {
    lastScopeKey.current = scopeKey
    setDraftState(readAgentComposerDraftCache(scopeKey))
  }

  useEffect(() => {
    adoptNativeChatDraftAppends(scopeKey)
    return subscribeAgentComposerDraftCache(scopeKey, setDraftState)
  }, [scopeKey])

  useEffect(
    () =>
      subscribeToNativeChatDraftAppend(scopeKey, (text) => {
        if (!isComposing()) {
          // the native cache already holds draft + text, and adopting it is idempotent across mounts
          writeAgentComposerDraftCache(scopeKey, readNativeChatDraftCache(scopeKey))
          return
        }
        const pending = pendingAppendRef.current
        pendingAppendRef.current = {
          scopeKey,
          text:
            pending?.scopeKey === scopeKey ? appendNativeChatDraftText(pending.text, text) : text
        }
      }),
    [isComposing, scopeKey]
  )

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

  const flushDraftAppends = useCallback(() => {
    const pending = pendingAppendRef.current
    pendingAppendRef.current = null
    if (pending?.scopeKey === scopeKey) {
      setDraft((previous) => appendNativeChatDraftText(previous, pending.text))
    }
  }, [scopeKey, setDraft])

  // A composer leaving mid-composition must not take the held text with it.
  useEffect(
    () => () => {
      const pending = pendingAppendRef.current
      if (pending?.scopeKey === scopeKey) {
        pendingAppendRef.current = null
        writeAgentComposerDraftCache(
          scopeKey,
          appendNativeChatDraftText(readAgentComposerDraftCache(scopeKey), pending.text)
        )
      }
    },
    [scopeKey]
  )

  return { draft, setDraft, flushDraftAppends }
}
