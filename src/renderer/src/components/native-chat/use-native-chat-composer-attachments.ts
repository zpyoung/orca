import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { translate } from '@/i18n/i18n'
import { NATIVE_FILE_DROP_MAX_PATHS } from '../../../../shared/native-file-drop'
import { isNativeChatImageAttachmentPath } from './native-chat-image-paste'
import {
  formatNativeChatFileReference,
  nativeChatComposerTargetIsRemote,
  type NativeChatResolvedTarget
} from './native-chat-composer-target'
import type { AgentComposerImageAttachment } from './fork-agent-composer/AgentComposerField'
import {
  readNativeChatAttachmentCache,
  subscribeNativeChatAttachmentCache,
  writeNativeChatAttachmentCache
} from './fork-agent-composer/agent-composer-attachment-cache'
export {
  clearNativeChatAttachmentCacheForTests,
  readNativeChatAttachmentCache,
  subscribeNativeChatAttachmentCache
} from './fork-agent-composer/agent-composer-attachment-cache'

export type UseNativeChatComposerAttachmentsArgs = {
  attachmentScopeKey: string
  allowWithoutTarget?: boolean
  caret: number
  disabled: boolean
  isComposing: () => boolean
  resolveTarget: () => NativeChatResolvedTarget | null
  textareaRef: RefObject<HTMLTextAreaElement | null>
  setCaret: (caret: number) => void
  setDraft: (updater: (previous: string) => string) => void
  setNotice: (notice: string | null) => void
}

export function useNativeChatComposerAttachments({
  attachmentScopeKey,
  allowWithoutTarget = false,
  caret,
  disabled,
  isComposing,
  resolveTarget,
  textareaRef,
  setCaret,
  setDraft,
  setNotice
}: UseNativeChatComposerAttachmentsArgs): {
  imageAttachments: AgentComposerImageAttachment[]
  appendImageAttachments: (paths: string[]) => void
  attachResolvedPaths: (paths: string[], connectionId?: string | null) => void
  clearImageAttachments: () => void
  flushPendingAttachments: () => void
  restoreImageAttachments: (attachments: readonly AgentComposerImageAttachment[]) => void
  removeImageAttachment: (id: string) => void
} {
  const [imageAttachments, setImageAttachments] = useState<AgentComposerImageAttachment[]>(() =>
    readNativeChatAttachmentCache(attachmentScopeKey)
  )
  const imageAttachmentCounter = useRef(0)
  const pendingResolvedPathsRef = useRef<{ path: string; connectionId?: string | null }[]>([])
  const pendingPathLimitRejectedRef = useRef(false)
  const disabledRef = useRef(disabled)

  useLayoutEffect(() => {
    disabledRef.current = disabled
    if (disabled) {
      pendingResolvedPathsRef.current = []
      pendingPathLimitRejectedRef.current = false
    }
  }, [disabled])

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
    (paths: { path: string; connectionId?: string | null }[]) => {
      if (paths.length === 0) {
        return
      }
      updateImageAttachments((prev) => [
        ...prev,
        ...paths.map(({ path, connectionId }) => {
          imageAttachmentCounter.current += 1
          return {
            id: `${Date.now()}-${imageAttachmentCounter.current}`,
            path,
            connectionId: connectionId ?? undefined
          }
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
    },
    [caret, setCaret, setDraft, textareaRef]
  )

  // Attach paths the TARGET AGENT can read: local paths for local worktrees,
  // already-uploaded remote paths for SSH worktrees (the composer uploads
  // before calling this — see native-chat-attachment-upload.ts).
  const applyResolvedPaths = useCallback(
    (
      resolvedPaths: { path: string; connectionId?: string | null }[],
      focus: boolean,
      preserveNotice = false
    ) => {
      const target = resolveTarget()
      if (
        (!target && !allowWithoutTarget) ||
        (target && nativeChatComposerTargetIsRemote(target.ptyId))
      ) {
        setNotice(
          translate(
            'components.native-chat.composer.localAttachmentUnsupported',
            'Local attachments are not available for remote sessions.'
          )
        )
        return
      }
      const imagePaths = resolvedPaths.filter(({ path }) => isNativeChatImageAttachmentPath(path))
      const filePaths = resolvedPaths
        .filter(({ path }) => !isNativeChatImageAttachmentPath(path))
        .map(({ path }) => path)
      // Images are NOT sent to the TUI here — they ride along on submit (see
      // NativeChatComposer.send) so the GUI chips and the TUI input never
      // diverge and removing a chip needs no TUI un-paste.
      appendImageAttachments(imagePaths.map(({ path, connectionId }) => ({ path, connectionId })))
      insertFileReferences(filePaths)
      if (!preserveNotice) {
        setNotice(null)
      }
      if (focus && resolvedPaths.length > 0) {
        requestAnimationFrame(() => textareaRef.current?.focus())
      }
    },
    [
      allowWithoutTarget,
      appendImageAttachments,
      insertFileReferences,
      resolveTarget,
      setNotice,
      textareaRef
    ]
  )

  const attachResolvedPaths = useCallback(
    (paths: string[], connectionId?: string | null) => {
      if (paths.length === 0 || disabledRef.current) {
        return
      }
      if (isComposing()) {
        if (paths.length > NATIVE_FILE_DROP_MAX_PATHS - pendingResolvedPathsRef.current.length) {
          // Reject the whole completion so ordered path batches are never partially applied.
          pendingPathLimitRejectedRef.current = true
          setNotice(
            translate(
              'components.native-chat.composer.pendingAttachmentLimit',
              'Too many attachments are waiting. Finish composing before attaching more.'
            )
          )
          return
        }
        pendingResolvedPathsRef.current.push(...paths.map((path) => ({ path, connectionId })))
        return
      }
      applyResolvedPaths(
        paths.map((path) => ({ path, connectionId })),
        true
      )
    },
    [applyResolvedPaths, isComposing, setNotice]
  )

  const flushPendingAttachments = useCallback(() => {
    const paths = pendingResolvedPathsRef.current
    const preserveNotice = pendingPathLimitRejectedRef.current
    pendingResolvedPathsRef.current = []
    pendingPathLimitRejectedRef.current = false
    if (paths.length === 0 || disabledRef.current) {
      return
    }
    applyResolvedPaths(paths, false, preserveNotice)
  }, [applyResolvedPaths])

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
    // the fork's hosts attach local paths only; upstream's per-path connectionId is carried by
    // attachResolvedPaths, which is the path a remote upload actually takes
    appendImageAttachments: (paths: string[]) =>
      appendImageAttachments(paths.map((path) => ({ path }))),
    attachResolvedPaths,
    clearImageAttachments: () => updateImageAttachments(() => []),
    flushPendingAttachments,
    restoreImageAttachments,
    removeImageAttachment: (id) =>
      updateImageAttachments((prev) => prev.filter((attachment) => attachment.id !== id))
  }
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
