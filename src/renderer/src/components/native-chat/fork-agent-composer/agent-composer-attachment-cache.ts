import type { AgentComposerImageAttachment } from './AgentComposerField'
import { createSubscribableScopeCache } from './agent-composer-scope-cache'

const attachmentCache = createSubscribableScopeCache<AgentComposerImageAttachment[]>({
  createEmptyValue: () => [],
  isEmpty: (attachments) => attachments.length === 0,
  copyValue: (attachments) => [...attachments]
})

export const readNativeChatAttachmentCache = attachmentCache.read

export function writeNativeChatAttachmentCache(
  scopeKey: string,
  attachments: readonly AgentComposerImageAttachment[]
): void {
  attachmentCache.write(scopeKey, [...attachments])
}

/**
 * Subscribes to writes for `scopeKey`. Fires once immediately with the
 * current value, then on every subsequent write, so a restore from a
 * different host's unmounting hook instance still reaches whichever host is
 * live for this scope. Returns an unsubscribe function.
 */
export const subscribeNativeChatAttachmentCache = attachmentCache.subscribe

export const clearNativeChatAttachmentCacheForTests = attachmentCache.clearForTests
