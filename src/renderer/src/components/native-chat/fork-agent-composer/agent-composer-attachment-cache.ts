import type { AgentComposerImageAttachment } from './AgentComposerField'
import { createSubscribableScopeCache } from './agent-composer-scope-cache'

const attachmentCache = createSubscribableScopeCache<AgentComposerImageAttachment[]>({
  createEmptyValue: () => [],
  isEmpty: (attachments) => attachments.length === 0,
  copyValue: (attachments) => [...attachments]
})

export const readNativeChatAttachmentCache = attachmentCache.read

/**
 * Caches only what another mount may safely adopt.
 *
 * A pending chip's save resolves into the host that started it, so restoring one elsewhere
 * would strand it pending forever. Preview URLs can retain the whole clipboard Blob for the
 * lifetime of the scope, and a settled chip reloads from its authorized path anyway.
 */
export function writeNativeChatAttachmentCache(
  scopeKey: string,
  attachments: readonly AgentComposerImageAttachment[]
): void {
  attachmentCache.write(
    scopeKey,
    attachments
      .filter((attachment) => !attachment.pending)
      .map(({ previewUrl: _previewUrl, ...attachment }) => attachment)
  )
}

/**
 * Subscribes to writes for `scopeKey`. Fires once immediately with the
 * current value, then on every subsequent write, so a restore from a
 * different host's unmounting hook instance still reaches whichever host is
 * live for this scope. Returns an unsubscribe function.
 */
export const subscribeNativeChatAttachmentCache = attachmentCache.subscribe

export const clearNativeChatAttachmentCacheForTests = attachmentCache.clearForTests
