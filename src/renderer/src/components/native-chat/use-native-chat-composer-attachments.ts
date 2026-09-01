import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
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
  attachResolvedPaths: (paths: string[]) => void
  clearImageAttachments: () => void
  restoreImageAttachments: (attachments: readonly AgentComposerImageAttachment[]) => void
  removeImageAttachment: (id: string) => void
} {
  const [imageAttachments, setImageAttachments] = useState<AgentComposerImageAttachment[]>(() =>
    readNativeChatAttachmentCache(attachmentScopeKey)
  )
  const imageAttachmentCounter = useRef(0)
  const pendingResolvedPathsRef = useRef<string[]>([])
  const pendingPathLimitRejectedRef = useRef(false)
  const disabledRef = useRef(disabled)

  useLayoutEffect(() => {
    disabledRef.current = disabled
    if (disabled) {
      pendingResolvedPathsRef.current = []
      pendingPathLimitRejectedRef.current = false
    }
  }, [disabled])

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
    },
    [caret, setCaret, setDraft, textareaRef]
  )

  // Attach paths the TARGET AGENT can read: local paths for local worktrees,
  // already-uploaded remote paths for SSH worktrees (the composer uploads
  // before calling this — see native-chat-attachment-upload.ts).
  const applyResolvedPaths = useCallback(
    (paths: string[], focus: boolean, preserveNotice = false) => {
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
      const imagePaths = paths.filter(isNativeChatImageAttachmentPath)
      const filePaths = paths.filter((path) => !isNativeChatImageAttachmentPath(path))
      // Images are NOT sent to the TUI here — they ride along on submit (see
      // NativeChatComposer.send) so the GUI chips and the TUI input never
      // diverge and removing a chip needs no TUI un-paste.
      appendImageAttachments(imagePaths)
      insertFileReferences(filePaths)
      if (!preserveNotice) {
        setNotice(null)
      }
      if (focus && paths.length > 0) {
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
    attachResolvedPaths,
    clearImageAttachments: () => updateImageAttachments(() => []),
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
