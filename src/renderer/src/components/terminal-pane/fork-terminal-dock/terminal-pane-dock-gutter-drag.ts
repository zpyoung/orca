import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { holdPtyResizesForPaneSubtrees } from '@/lib/pane-manager/pane-pty-resize-hold'
import { safeFit } from '@/lib/pane-manager/pane-fit'
import { MAX_GUTTER_ROWS, MIN_GUTTER_ROWS } from './terminal-dock-pane-state'
import { TERMINAL_DOCK_ROW_HEIGHT_PX } from './TerminalDock'

export function clampGutterRows(rows: number): number {
  return Math.min(MAX_GUTTER_ROWS, Math.max(MIN_GUTTER_ROWS, Math.round(rows)))
}

export type TerminalDockGutterDragArgs = {
  pane: ManagedPane
  startGutterRows: number
  /** Applied on every rAF-batched pointermove so xterm can fit locally during the drag, and
   *  once more on a fresh release-time row change before the deferred fit/flush (see finish). */
  onLiveRowsChange: (rows: number) => void
  /** Applied once on a committed release, after the single coalesced PTY resize flushes. */
  onCommit: (rows: number) => void
  /** Fires exactly once on every drag termination — changed commit, unchanged release,
   *  pointercancel, blur, or a programmatic cancel — so callers can clear per-drag state
   *  (e.g. a live-preview flag) that must never outlive the gesture. */
  onSettled: () => void
}

type PointerCaptureTarget = {
  setPointerCapture: (pointerId: number) => void
  hasPointerCapture: (pointerId: number) => boolean
  releasePointerCapture: (pointerId: number) => void
}

/** Drags the strip above the dock to resize its gutter. Mirrors pane-divider-drag's
 *  hold-through-drag/flush-once-on-release shape (rAF-batched live updates, pointer capture
 *  with a window-level fallback, abort-safe cancel) collapsed to a single row-count axis. */
export function beginTerminalDockGutterDrag(
  event: { clientY: number; pointerId: number; currentTarget: PointerCaptureTarget },
  args: TerminalDockGutterDragArgs,
  fit: (pane: ManagedPane) => boolean = safeFit
): () => void {
  const handle = event.currentTarget
  const startY = event.clientY
  const { pane, startGutterRows, onLiveRowsChange, onCommit, onSettled } = args
  let liveRows = startGutterRows
  let pendingRows: number | null = null
  let rafId: number | null = null
  let settleRafId: number | null = null
  let released = false

  const release = holdPtyResizesForPaneSubtrees([pane.container])

  const applyPendingRows = (): void => {
    rafId = null
    if (pendingRows === null) {
      return
    }
    liveRows = pendingRows
    pendingRows = null
    onLiveRowsChange(liveRows)
    fit(pane)
  }

  const scheduleRows = (rows: number): void => {
    pendingRows = rows
    if (rafId === null) {
      rafId = requestAnimationFrame(applyPendingRows)
    }
  }

  const cancelScheduledFrame = (): void => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
  }

  const removeListeners = (): void => {
    window.removeEventListener('pointermove', onPointerMove, true)
    window.removeEventListener('pointerup', onPointerUp, true)
    window.removeEventListener('pointercancel', onPointerCancel, true)
    window.removeEventListener('blur', onBlur, true)
  }

  const finish = (commit: boolean): void => {
    if (released) {
      return
    }
    released = true
    cancelScheduledFrame()
    removeListeners()
    try {
      if (handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId)
      }
    } catch {
      // Best effort: capture may already be gone.
    }

    if (commit) {
      const finalRows = pendingRows ?? liveRows
      const hadFreshRowChange = pendingRows !== null
      const rowsChanged = finalRows !== startGutterRows
      liveRows = finalRows
      pendingRows = null

      const fitAndFlush = (): void => {
        fit(pane)
        release.flush()
      }

      if (hadFreshRowChange) {
        onLiveRowsChange(finalRows)
      }
      // Why: onSettled (freeing auto-undock re-evaluation, see useAutoUndock) and onCommit
      // both fire before the fit/flush below (not after, as a plain fire-and-forget) so their
      // downstream effects land under this same still-open hold instead of triggering their
      // own separate, unheld resize once this one releases.
      onSettled()
      if (rowsChanged) {
        onCommit(finalRows)
      }

      if (hadFreshRowChange || rowsChanged) {
        // Why: the row/mount-state updates above land through React a frame later. Fitting
        // here would measure stale geometry and flush it while the hold is still open, then
        // the real, later layout change triggers its own unheld resize once this hold
        // releases — two PTY SIGWINCHes for one release. Deferring a frame lets fit read the
        // settled size.
        settleRafId = requestAnimationFrame(() => {
          settleRafId = null
          fitAndFlush()
        })
      } else {
        fitAndFlush()
      }
    } else {
      onLiveRowsChange(startGutterRows)
      onSettled()
      fit(pane)
      release.cancel()
    }
  }

  const onPointerMove = (moveEvent: PointerEvent): void => {
    if (moveEvent.pointerId !== event.pointerId) {
      return
    }
    // Why: dragging the handle up should grow the gutter, so pixels above start are positive rows.
    const deltaRows = Math.round((startY - moveEvent.clientY) / TERMINAL_DOCK_ROW_HEIGHT_PX)
    scheduleRows(clampGutterRows(startGutterRows + deltaRows))
  }
  const onPointerUp = (upEvent: PointerEvent): void => {
    if (upEvent.pointerId === event.pointerId) {
      finish(true)
    }
  }
  const onPointerCancel = (cancelEvent: PointerEvent): void => {
    if (cancelEvent.pointerId === event.pointerId) {
      finish(false)
    }
  }
  const onBlur = (): void => finish(false)

  try {
    handle.setPointerCapture(event.pointerId)
  } catch {
    // Some pointer types (or test doubles) don't support capture; window listeners still work.
  }
  window.addEventListener('pointermove', onPointerMove, true)
  window.addEventListener('pointerup', onPointerUp, true)
  window.addEventListener('pointercancel', onPointerCancel, true)
  window.addEventListener('blur', onBlur, true)

  return () => {
    if (!released) {
      finish(false)
      return
    }
    if (settleRafId !== null) {
      cancelAnimationFrame(settleRafId)
      settleRafId = null
      release.cancel()
    }
  }
}
