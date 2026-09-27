import { useCallback, useEffect } from 'react'
import type { RefObject } from 'react'
import { APP_MENU_PASTE_EVENT } from '@/lib/app-menu-paste'
import { pasteTextIntoTextControl, TEXT_CONTROL_PASTE_MAX_BYTES } from '@/lib/text-control-paste'
import type { NativeChatComposerHandle } from './NativeChatComposer'

type NativeChatPasteBridgeRefs = {
  rootRef: RefObject<HTMLDivElement | null>
  composerRef: RefObject<NativeChatComposerHandle | null>
  /** The question card's free-text answer input; the paste target while the
   *  card owns the input region (the composer is unmounted then). */
  questionAnswerInputRef?: RefObject<HTMLInputElement | null>
}

export function useNativeChatPasteBridge({
  rootRef,
  composerRef,
  questionAnswerInputRef
}: NativeChatPasteBridgeRefs): () => void {
  const pasteClipboardIntoComposer = useCallback(() => {
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
        await pasteTextIntoTextControl(answerInput, text, { source: 'programmatic' })
        return
      }
      composerRef.current?.pasteFromClipboard()
    })()
  }, [composerRef, questionAnswerInputRef])

  // Capture at the pane root so repeated composer mounts do not miss image paste.
  useEffect(() => {
    const root = rootRef.current
    if (!root) {
      return
    }
    const onPaste = (event: ClipboardEvent): void => {
      composerRef.current?.handlePasteEvent(event)
    }
    root.addEventListener('paste', onPaste, { capture: true })
    return () => {
      root.removeEventListener('paste', onPaste, { capture: true })
    }
  }, [composerRef, rootRef])

  useEffect(() => {
    const onAppMenuPaste = (event: Event): void => {
      const root = rootRef.current
      const activeElement = document.activeElement
      // The app-menu paste event is window-scoped; only claim it when focus is
      // inside this chat pane so multiple panes don't all react to one Cmd+V.
      if (!root || !(activeElement instanceof Element) || !root.contains(activeElement)) {
        return
      }
      // No paste target mounted: leave the event unclaimed so the shared
      // app-menu handler can resolve the focused text control itself.
      if (!composerRef.current && !questionAnswerInputRef?.current) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      pasteClipboardIntoComposer()
    }

    window.addEventListener(APP_MENU_PASTE_EVENT, onAppMenuPaste)
    return () => {
      window.removeEventListener(APP_MENU_PASTE_EVENT, onAppMenuPaste)
    }
  }, [composerRef, pasteClipboardIntoComposer, questionAnswerInputRef, rootRef])

  return pasteClipboardIntoComposer
}
