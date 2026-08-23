export type PaneFocusOwnershipTracker = {
  hasFocus: () => boolean
  dispose: () => void
}

/** Tracks whether DOM focus currently lives inside a pane's subtree, so dock-mount focus
 *  transitions can tell the active (focused) pane from a background one without a prop
 *  threaded down from the pane manager's own active-pane state. Only 'focusin' is used —
 *  never 'focusout' — and a target of `document.body` is ignored, since that's the
 *  browser's transient fixup target when a focused node (e.g. an unmounting composer) is
 *  removed from the DOM; without that filter, a pane's own composer disappearing mid-
 *  transition would read as focus having left before this pane's effects even run. */
export function trackPaneFocusOwnership(
  container: HTMLElement,
  doc: Document = document
): PaneFocusOwnershipTracker {
  let owned = container.contains(doc.activeElement)
  const onFocusIn = (event: FocusEvent): void => {
    if (event.target === doc.body) {
      return
    }
    owned = event.target instanceof Node && container.contains(event.target)
  }
  doc.addEventListener('focusin', onFocusIn, true)
  return {
    hasFocus: () => owned,
    dispose: () => doc.removeEventListener('focusin', onFocusIn, true)
  }
}
