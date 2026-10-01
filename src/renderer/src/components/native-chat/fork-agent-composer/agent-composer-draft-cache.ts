// Module-level cache for the composer's in-progress draft text, keyed by the
// same stable pane scope as image attachments. The composer unmounts when the
// pane toggles back to the hosted terminal, so without this the typed-but-unsent
// draft would be lost on every TUI/GUI round-trip. Mirrors the attachment cache
// so both halves of an unsent message survive toggles and reconnects. Also
// mirrors agent-composer-history-cache's subscribe/notify shape, since the dock
// and native-chat view can both hold a live mount against the same pane.

import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache,
  writeNativeChatDraftCache
} from '../native-chat-draft-cache'
import { createSubscribableScopeCache } from './agent-composer-scope-cache'

const draftCache = createSubscribableScopeCache<string>({
  createEmptyValue: () => '',
  isEmpty: (draft) => draft === ''
})

export const readAgentComposerDraftCache = draftCache.read

/**
 * Also mirrors the draft into upstream's native-chat draft cache, which is where a
 * withdrawn structured send is appended back (`appendNativeChatDraftCache`), so that
 * append lands after what is actually typed.
 */
export function writeAgentComposerDraftCache(scopeKey: string, draft: string): void {
  writeNativeChatDraftCache(scopeKey, draft)
  draftCache.write(scopeKey, draft)
}

/**
 * Adopts text appended to the native-chat cache while no composer for `scopeKey`
 * was mounted to hear it. Every fork write mirrors there, so the two differ only then.
 */
export function adoptNativeChatDraftAppends(scopeKey: string): void {
  const appended = readNativeChatDraftCache(scopeKey)
  if (appended !== '' && appended !== draftCache.read(scopeKey)) {
    draftCache.write(scopeKey, appended)
  }
}

/**
 * Subscribes to writes for `scopeKey`. Fires once immediately with the
 * current value, then on every subsequent write, so a mount that subscribes
 * after another mount already wrote cannot miss that entry. Returns an
 * unsubscribe function.
 */
export const subscribeAgentComposerDraftCache = draftCache.subscribe

export function clearAgentComposerDraftCacheForTests(): void {
  draftCache.clearForTests()
  clearNativeChatDraftCacheForTests()
}
