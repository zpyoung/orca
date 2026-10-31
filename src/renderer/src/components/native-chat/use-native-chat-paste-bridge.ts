import { nativeChatComposerDestination } from './native-chat-composer-destination'
import { useCallback, useEffect } from 'react'
import type { RefObject } from 'react'
import { toast } from 'sonner'
import { isEditableTarget } from '@/lib/editable-target'
import {
  NativeChatPasteRequest,
  findNativeChatAnswerField,
  findNativeChatPasteField,
  nativeChatPasteUnavailableNotice,
  NATIVE_CHAT_PASTE_REQUEST_EVENT
} from '@/lib/native-chat-paste-request'
import { APP_MENU_PASTE_EVENT } from '@/lib/app-menu-paste'
import { isWebClientLocation } from '@/lib/web-client-location'
import { pasteTextIntoTextControl, TEXT_CONTROL_PASTE_MAX_BYTES } from '@/lib/text-control-paste'
import type { NativeChatComposerHandle } from './NativeChatComposer'

type NativeChatPasteBridgeRefs = {
  rootRef: RefObject<HTMLDivElement | null>
  composerRef: RefObject<NativeChatComposerHandle | null>
  /** Paste here while the question card owns input and the composer is unmounted. */
  questionAnswerInputRef?: RefObject<HTMLInputElement | null>
}

/** Text-only on purpose: an answer input takes no image attachments. */
function pasteClipboardTextInto(input: HTMLInputElement, stillTarget: () => boolean): void {
  void (async () => {
    const text = await window.api.ui
      .readClipboardText({ maxBytes: TEXT_CONTROL_PASTE_MAX_BYTES })
      .catch(() => '')
    if (text.length > 0 && stillTarget()) {
      await pasteTextIntoTextControl(input, text, {
        source: 'programmatic',
        canContinue: stillTarget
      })
    }
  })()
}

export function useNativeChatPasteBridge({
  rootRef,
  composerRef,
  questionAnswerInputRef
}: NativeChatPasteBridgeRefs): (origin?: HTMLTextAreaElement | HTMLInputElement) => void {
  const pasteClipboardIntoComposer = useCallback(
    (
      origin?: HTMLTextAreaElement | HTMLInputElement,
      mode: 'paste' | 'paste-and-match-style' = 'paste'
    ) => {
      if (origin instanceof HTMLInputElement) {
        if (findNativeChatAnswerField(origin, rootRef.current) === origin) {
          pasteClipboardTextInto(origin, () => origin.isConnected)
        }
        return
      }
      if (origin) {
        if (findNativeChatPasteField(origin, rootRef.current) === origin) {
          origin.focus({ preventScroll: true })
          if (isWebClientLocation()) {
            origin.dispatchEvent(new NativeChatPasteRequest())
          } else {
            window.api.ui.performNativePaste({ mode })
          }
        } else {
          toast.error(nativeChatPasteUnavailableNotice())
        }
        return
      }
      const answerInput = questionAnswerInputRef?.current
      // Both targets can be mounted at once — the terminal dock keeps its composer
      // up beside an active card instead of unmounting it — so route by focus
      // rather than by whichever one happens to exist.
      const answerInputFocused = answerInput != null && document.activeElement === answerInput
      if (composerRef.current && !answerInputFocused) {
        composerRef.current.pasteFromClipboard()
        return
      }
      if (!answerInput) {
        return
      }
      // The answer input takes no image attachments, so it gets the text. An
      // image-only clipboard would otherwise vanish here: with no event in hand,
      // empty text is the only signal that the paste was an image, and the
      // composer's paste path is what knows how to save and attach one.
      void (async () => {
        const text = await window.api.ui
          .readClipboardText({ maxBytes: TEXT_CONTROL_PASTE_MAX_BYTES })
          .catch(() => '')
        if (text.length > 0) {
          if (questionAnswerInputRef?.current === answerInput) {
            await pasteTextIntoTextControl(answerInput, text, {
              source: 'programmatic',
              canContinue: () => questionAnswerInputRef?.current === answerInput
            })
          }
          return
        }
        composerRef.current?.pasteFromClipboard()
      })()
    },
    [composerRef, questionAnswerInputRef, rootRef]
  )

  // Capture at the pane so composer remounts cannot miss image pastes.
  useEffect(() => {
    const root = rootRef.current
    if (!root) {
      return
    }
    const onPaste = (event: ClipboardEvent): void => {
      if (event.defaultPrevented) {
        return
      }
      if (isEditableTarget(event.target)) {
        const composer = composerRef.current
        if (event.target instanceof Node && composer?.contains?.(event.target)) {
          composer.handlePasteEvent(event)
          return
        }
        // The answer input takes no images, so a paste with no text attaches to the composer.
        const answerInput = questionAnswerInputRef?.current
        if (
          composer &&
          answerInput &&
          event.target === answerInput &&
          !event.clipboardData?.getData('text/plain')
        ) {
          composer.handlePasteEvent(event)
        }
        // Other text fields (search, answer) keep their native paste.
        return
      }
      const composer = nativeChatComposerDestination(rootRef.current, composerRef.current)
      if (composer) {
        composer.handlePasteEvent(event)
        event.preventDefault()
        return
      }
      const answerInput = questionAnswerInputRef?.current
      if (answerInput) {
        const text = event.clipboardData?.getData('text/plain')
        event.preventDefault()
        if (text) {
          void pasteTextIntoTextControl(answerInput, text, {
            source: 'programmatic',
            canContinue: () => questionAnswerInputRef?.current === answerInput
          })
        }
      }
      // Without mounted inputs, leave paste unclaimed so the chat cover shows its refusal.
    }
    // Chromium may target a stale selection in another pane or the body.
    const onOwnedPaste = (event: ClipboardEvent): void => {
      const field = findNativeChatPasteField(document.activeElement, root)
      if (event.defaultPrevented || !field) {
        return
      }
      field.focus({ preventScroll: true })
      if (event.target !== field) {
        field.dispatchEvent(new NativeChatPasteRequest(event))
        event.preventDefault()
      }
    }
    // Named-pane paste requests carry no clipboard event data.
    const onPasteRequest = (event: Event): void => {
      if (
        nativeChatComposerDestination(rootRef.current, composerRef.current) ||
        questionAnswerInputRef?.current
      ) {
        event.preventDefault()
        pasteClipboardIntoComposer()
      }
    }
    const onAppMenuPaste = (event: Event & { detail?: unknown }): void => {
      if (event.defaultPrevented) {
        return
      }
      const activeElement = document.activeElement
      if (!(activeElement instanceof Element) || !root.contains(activeElement)) {
        return
      }
      const field = findNativeChatPasteField(activeElement, root)
      if (field) {
        event.preventDefault()
        pasteClipboardIntoComposer(
          field,
          event.detail === 'paste-and-match-style' ? 'paste-and-match-style' : 'paste'
        )
        return
      }
      if (
        isEditableTarget(activeElement) &&
        !composerRef.current?.contains?.(activeElement) &&
        activeElement !== questionAnswerInputRef?.current
      ) {
        return
      }
      onPasteRequest(event)
    }

    window.addEventListener('paste', onOwnedPaste, true)
    root.addEventListener('paste', onPaste, { capture: true })
    root.addEventListener(NATIVE_CHAT_PASTE_REQUEST_EVENT, onPasteRequest)
    window.addEventListener(APP_MENU_PASTE_EVENT, onAppMenuPaste)
    return () => {
      window.removeEventListener('paste', onOwnedPaste, true)
      root.removeEventListener('paste', onPaste, { capture: true })
      root.removeEventListener(NATIVE_CHAT_PASTE_REQUEST_EVENT, onPasteRequest)
      window.removeEventListener(APP_MENU_PASTE_EVENT, onAppMenuPaste)
    }
  }, [composerRef, pasteClipboardIntoComposer, questionAnswerInputRef, rootRef])

  return pasteClipboardIntoComposer
}
