// Module-level cache for the composer's in-progress draft text, keyed by the
// same stable pane scope as image attachments. The composer unmounts when the
// pane toggles back to the hosted terminal, so without this the typed-but-unsent
// draft would be lost on every TUI/GUI round-trip. Mirrors the attachment cache
// so both halves of an unsent message survive toggles and reconnects. Also
// mirrors agent-composer-history-cache's subscribe/notify shape, since the dock
// and native-chat view can both hold a live mount against the same pane.

import { createSubscribableScopeCache } from './agent-composer-scope-cache'

const draftCache = createSubscribableScopeCache<string>({
  createEmptyValue: () => '',
  isEmpty: (draft) => draft === ''
})

export const readAgentComposerDraftCache = draftCache.read
export const writeAgentComposerDraftCache = draftCache.write

/**
 * Subscribes to writes for `scopeKey`. Fires once immediately with the
 * current value, then on every subsequent write, so a mount that subscribes
 * after another mount already wrote cannot miss that entry. Returns an
 * unsubscribe function.
 */
export const subscribeAgentComposerDraftCache = draftCache.subscribe

export const clearAgentComposerDraftCacheForTests = draftCache.clearForTests
