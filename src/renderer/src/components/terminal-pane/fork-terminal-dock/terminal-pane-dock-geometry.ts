import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { holdPtyResizesForPaneSubtrees } from '@/lib/pane-manager/pane-pty-resize-hold'
import { safeFit } from '@/lib/pane-manager/pane-fit'

/** Applies a dock mount/unmount/resize's DOM geometry change while holding the pane's PTY
 *  resize, then flushes once — so a change that might touch xterm's grid more than once
 *  (fit's own internal retries, a stray ResizeObserver tick) still reaches the PTY as a
 *  single SIGWINCH instead of a burst that visibly "vibrates" an agent TUI. `fit` is
 *  injectable so callers/tests can observe the hold without a real xterm attached. */
export function applyTerminalDockGeometryChange(
  pane: ManagedPane,
  fit: (pane: ManagedPane) => boolean = safeFit,
  mutateGeometry: () => void = () => {}
): void {
  const release = holdPtyResizesForPaneSubtrees([pane.container])
  try {
    mutateGeometry()
    fit(pane)
  } finally {
    release.flush()
  }
}
