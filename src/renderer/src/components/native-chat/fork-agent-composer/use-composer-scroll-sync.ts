import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'

/** Keeps a read-only composer mirror on the textarea's native scroll position. */
export function useComposerScrollSync(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  text: string
): RefObject<HTMLDivElement | null> {
  const overlayRef = useRef<HTMLDivElement>(null)
  const syncScroll = useCallback(() => {
    const textarea = textareaRef.current
    const overlay = overlayRef.current
    if (!textarea || !overlay) {
      return
    }
    overlay.scrollTop = textarea.scrollTop
    overlay.scrollLeft = textarea.scrollLeft
  }, [textareaRef])

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) {
      return
    }
    textarea.addEventListener('scroll', syncScroll, { passive: true })
    syncScroll()
    return () => textarea.removeEventListener('scroll', syncScroll)
  }, [syncScroll, textareaRef])

  useLayoutEffect(syncScroll, [syncScroll, text])

  return overlayRef
}
