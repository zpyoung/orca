import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { translate } from '@/i18n/i18n'
import { isNativeChatImageAttachmentPath } from './native-chat-image-paste'
import {
  formatNativeChatFileReference,
  nativeChatComposerTargetIsRemote,
  type NativeChatResolvedTarget
} from './native-chat-composer-target'
import type { AgentComposerImageAttachment } from '../agent-composer/AgentComposerField'
import {
  pinScopeCacheKey,
  setBoundedScopeCacheEntry
} from '../agent-composer/agent-composer-scope-cache'

export type UseNativeChatComposerAttachmentsArgs = {
  attachmentScopeKey: string
  caret: number
  resolveTarget: () => NativeChatResolvedTarget | null
  textareaRef: RefObject<HTMLTextAreaElement | null>
  setCaret: (caret: number) => void
  setDraft: (updater: (previous: string) => string) => void
  setNotice: (notice: string | null) => void
}

export function useNativeChatComposerAttachments({
  attachmentScopeKey,
  caret,
  resolveTarget,
  textareaRef,
  setCaret,
  setDraft,
  setNotice
}: UseNativeChatComposerAttachmentsArgs): {
  imageAttachments: AgentComposerImageAttachment[]
  appendImageAttachments: (paths: string[]) => void
  attachResolvedPaths: (paths: string[]) => void
  clearImageAttachments: () => void
  restoreImageAttachments: (attachments: readonly AgentComposerImageAttachment[]) => void
  removeImageAttachment: (id: string) => void
} {
  const [imageAttachments, setImageAttachments] = useState<AgentComposerImageAttachment[]>(() =>
    readNativeChatAttachmentCache(attachmentScopeKey)
  )
  const imageAttachmentCounter = useRef(0)

  // Reload chips from the cache when the composer is reused for a different pane
  // (scope-key change), adjusting state during render rather than in an effect.
  // Without this the previous pane's chips would stay live and be submitted to
  // the new target now that images are deferred to submit.
  const lastScopeKey = useRef(attachmentScopeKey)
  if (lastScopeKey.current !== attachmentScopeKey) {
    lastScopeKey.current = attachmentScopeKey
    setImageAttachments(readNativeChatAttachmentCache(attachmentScopeKey))
  }

  // A restore performed by another host's unmounting hook instance (e.g. a
  // cancelled send during a dock/native-chat transition) must reach whichever
  // host is live for this scope, not just the mount that wrote it.
  useEffect(
    () => subscribeNativeChatAttachmentCache(attachmentScopeKey, setImageAttachments),
    [attachmentScopeKey]
  )

  const updateImageAttachments = useCallback(
    (updater: (previous: AgentComposerImageAttachment[]) => AgentComposerImageAttachment[]) => {
      // resolve against the cache's current value, not this mount's possibly-stale state;
      // the write's own notification (via the subscription above) updates this mount's state
      const next = updater(readNativeChatAttachmentCache(attachmentScopeKey))
      writeNativeChatAttachmentCache(attachmentScopeKey, next)
    },
    [attachmentScopeKey]
  )

  const appendImageAttachments = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) {
        return
      }
      updateImageAttachments((prev) => [
        ...prev,
        ...paths.map((path) => {
          imageAttachmentCounter.current += 1
          return { id: `${Date.now()}-${imageAttachmentCounter.current}`, path }
        })
      ])
    },
    [updateImageAttachments]
  )

  const insertFileReferences = useCallback(
    (paths: string[]) => {
      const references = paths.map(formatNativeChatFileReference).join(' ')
      if (references.length === 0) {
        return
      }
      const insertion = `${references} `
      const caretAtInsert = textareaRef.current?.selectionStart ?? caret
      setDraft((prev) => {
        const before = prev.slice(0, caretAtInsert)
        const after = prev.slice(caretAtInsert)
        const next = before + insertion + after
        setCaret(before.length + insertion.length)
        return next
      })
      setNotice(null)
      requestAnimationFrame(() => textareaRef.current?.focus())
    },
    [caret, setCaret, setDraft, setNotice, textareaRef]
  )

  // Attach paths the TARGET AGENT can read: local paths for local worktrees,
  // already-uploaded remote paths for SSH worktrees (the composer uploads
  // before calling this — see native-chat-attachment-upload.ts).
  const attachResolvedPaths = useCallback(
    (paths: string[]) => {
      const target = resolveTarget()
      if (!target || nativeChatComposerTargetIsRemote(target.ptyId)) {
        setNotice(
          translate(
            'components.native-chat.composer.localAttachmentUnsupported',
            'Local attachments are not available for remote sessions.'
          )
        )
        return
      }
      const imagePaths = paths.filter(isNativeChatImageAttachmentPath)
      const filePaths = paths.filter((path) => !isNativeChatImageAttachmentPath(path))
      // Images are NOT sent to the TUI here — they ride along on submit (see
      // NativeChatComposer.send) so the GUI chips and the TUI input never
      // diverge and removing a chip needs no TUI un-paste.
      appendImageAttachments(imagePaths)
      insertFileReferences(filePaths)
      if (imagePaths.length > 0) {
        setNotice(null)
        requestAnimationFrame(() => textareaRef.current?.focus())
      }
    },
    [appendImageAttachments, insertFileReferences, resolveTarget, setNotice, textareaRef]
  )

  const restoreImageAttachments = useCallback(
    (attachments: readonly AgentComposerImageAttachment[]) => {
      // the write's own notification (via the subscription above) updates live mounts' state,
      // including a replacement host mounted after this call's caller started unmounting
      restoreNativeChatAttachmentCache(attachmentScopeKey, attachments)
    },
    [attachmentScopeKey]
  )

  return {
    imageAttachments,
    appendImageAttachments,
    attachResolvedPaths,
    clearImageAttachments: () => updateImageAttachments(() => []),
    restoreImageAttachments,
    removeImageAttachment: (id) =>
      updateImageAttachments((prev) => prev.filter((attachment) => attachment.id !== id))
  }
}

const attachmentCache = new Map<string, AgentComposerImageAttachment[]>()

type AttachmentCacheListener = (attachments: AgentComposerImageAttachment[]) => void
const attachmentCacheListeners = new Map<string, Set<AttachmentCacheListener>>()

export function readNativeChatAttachmentCache(scopeKey: string): AgentComposerImageAttachment[] {
  return [...(attachmentCache.get(scopeKey) ?? [])]
}

function writeNativeChatAttachmentCache(
  scopeKey: string,
  attachments: readonly AgentComposerImageAttachment[]
): void {
  if (attachments.length === 0) {
    attachmentCache.delete(scopeKey)
  } else {
    // LRU-bounded so pending attachments for permanently-removed panes can't accumulate.
    setBoundedScopeCacheEntry(attachmentCache, scopeKey, [...attachments])
  }
  notifyAttachmentCacheListeners(scopeKey, [...attachments])
}

export function restoreNativeChatAttachmentCache(
  scopeKey: string,
  attachments: readonly AgentComposerImageAttachment[]
): AgentComposerImageAttachment[] {
  const current = readNativeChatAttachmentCache(scopeKey)
  const paths = new Set(current.map((attachment) => attachment.path))
  const restored = [...current]
  for (const attachment of attachments) {
    if (!paths.has(attachment.path)) {
      paths.add(attachment.path)
      restored.push(attachment)
    }
  }
  writeNativeChatAttachmentCache(scopeKey, restored)
  return restored
}

/**
 * Subscribes to writes for `scopeKey`. Fires once immediately with the
 * current value, then on every subsequent write, so a restore from a
 * different host's unmounting hook instance still reaches whichever host is
 * live for this scope. Returns an unsubscribe function.
 */
export function subscribeNativeChatAttachmentCache(
  scopeKey: string,
  listener: AttachmentCacheListener
): () => void {
  const listeners = attachmentCacheListeners.get(scopeKey) ?? new Set<AttachmentCacheListener>()
  attachmentCacheListeners.set(scopeKey, listeners)
  listeners.add(listener)
  const unpin = pinScopeCacheKey(scopeKey)
  try {
    listener(readNativeChatAttachmentCache(scopeKey))
  } catch {
    // a subscriber's exception must never stop this subscribe call from completing
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      attachmentCacheListeners.delete(scopeKey)
    }
    unpin()
  }
}

function notifyAttachmentCacheListeners(
  scopeKey: string,
  attachments: AgentComposerImageAttachment[]
): void {
  const listeners = attachmentCacheListeners.get(scopeKey)
  if (!listeners) {
    return
  }
  // snapshot: a listener unsubscribing another mid-dispatch must not skip it
  for (const listener of Array.from(listeners)) {
    try {
      listener(attachments)
    } catch {
      // a subscriber's exception must never block the other listeners
    }
  }
}

export function clearNativeChatAttachmentCacheForTests(): void {
  attachmentCache.clear()
  attachmentCacheListeners.clear()
}
