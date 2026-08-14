// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { queuePanePtyResizeIfHeld } from '@/lib/pane-manager/pane-pty-resize-hold'
import { beginTerminalDockGutterDrag, clampGutterRows } from './terminal-pane-dock-gutter-drag'

function makeFakePane(): ManagedPane {
  const container = document.createElement('div')
  container.className = 'pane'
  container.dataset.paneId = '1'
  return { container } as unknown as ManagedPane
}

function makeHandle(): {
  setPointerCapture: () => void
  hasPointerCapture: () => boolean
  releasePointerCapture: () => void
} {
  return {
    setPointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => true),
    releasePointerCapture: vi.fn()
  }
}

function dispatchWindow(
  type: string,
  init: Partial<{ clientY: number; pointerId: number }> = {}
): void {
  const event = new Event(type) as PointerEvent
  Object.defineProperty(event, 'clientY', { value: init.clientY ?? 0 })
  Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 })
  window.dispatchEvent(event)
}

describe('beginTerminalDockGutterDrag', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('clamps rows to the documented 3..15 range', () => {
    expect(clampGutterRows(1)).toBe(3)
    expect(clampGutterRows(30)).toBe(15)
    expect(clampGutterRows(7.4)).toBe(7)
  })

  it('fires exactly one PTY resize on a committed release, after live row updates', async () => {
    const pane = makeFakePane()
    let flushCount = 0
    pane.container.addEventListener('orca-pane-pty-resize-hold-flush', () => {
      flushCount += 1
    })
    const liveRows: number[] = []
    const committedRows: number[] = []

    beginTerminalDockGutterDrag(
      { clientY: 100, pointerId: 1, currentTarget: makeHandle() },
      {
        pane,
        startGutterRows: 5,
        onLiveRowsChange: (rows) => liveRows.push(rows),
        onCommit: (rows) => committedRows.push(rows)
      },
      () => {
        queuePanePtyResizeIfHeld(pane.container, 80, 24)
        return true
      }
    )

    // Dragging up 40px == 2 rows (20px/row) grows the gutter.
    dispatchWindow('pointermove', { clientY: 60 })
    await new Promise((resolve) => requestAnimationFrame(resolve))
    dispatchWindow('pointermove', { clientY: 40 })
    await new Promise((resolve) => requestAnimationFrame(resolve))
    dispatchWindow('pointerup')

    expect(flushCount).toBe(1)
    expect(liveRows.at(-1)).toBe(8)
    expect(committedRows).toEqual([8])
  })

  it('cancels without committing or resizing when the drag aborts', async () => {
    const pane = makeFakePane()
    let flushCount = 0
    pane.container.addEventListener('orca-pane-pty-resize-hold-flush', () => {
      flushCount += 1
    })
    const liveRows: number[] = []
    const committedRows: number[] = []

    beginTerminalDockGutterDrag(
      { clientY: 100, pointerId: 1, currentTarget: makeHandle() },
      {
        pane,
        startGutterRows: 5,
        onLiveRowsChange: (rows) => liveRows.push(rows),
        onCommit: (rows) => committedRows.push(rows)
      },
      () => true
    )

    dispatchWindow('pointermove', { clientY: 40 })
    await new Promise((resolve) => requestAnimationFrame(resolve))
    dispatchWindow('pointercancel')

    expect(flushCount).toBe(0)
    expect(committedRows).toEqual([])
    expect(liveRows.at(-1)).toBe(5)
    expect(queuePanePtyResizeIfHeld(pane.container, 80, 24)).toBe(false)
  })

  it('returns a disposer that cancels an active drag and releases its PTY hold', () => {
    const pane = makeFakePane()
    const committedRows: number[] = []
    const dispose = beginTerminalDockGutterDrag(
      { clientY: 100, pointerId: 1, currentTarget: makeHandle() },
      {
        pane,
        startGutterRows: 5,
        onLiveRowsChange: () => {},
        onCommit: (rows) => committedRows.push(rows)
      },
      () => true
    )

    dispatchWindow('pointermove', { clientY: 40 })
    dispose()
    dispatchWindow('pointerup')

    expect(committedRows).toEqual([])
    expect(queuePanePtyResizeIfHeld(pane.container, 80, 24)).toBe(false)
  })

  it('does not commit when the release lands back on the starting row count', async () => {
    const pane = makeFakePane()
    const committedRows: number[] = []

    beginTerminalDockGutterDrag(
      { clientY: 100, pointerId: 1, currentTarget: makeHandle() },
      {
        pane,
        startGutterRows: 5,
        onLiveRowsChange: () => {},
        onCommit: (rows) => committedRows.push(rows)
      },
      () => true
    )

    dispatchWindow('pointerup')

    expect(committedRows).toEqual([])
  })

  it('ignores move/up/cancel events from a pointer other than the one that started the drag', async () => {
    const pane = makeFakePane()
    const liveRows: number[] = []
    const committedRows: number[] = []

    beginTerminalDockGutterDrag(
      { clientY: 100, pointerId: 1, currentTarget: makeHandle() },
      {
        pane,
        startGutterRows: 5,
        onLiveRowsChange: (rows) => liveRows.push(rows),
        onCommit: (rows) => committedRows.push(rows)
      },
      () => true
    )

    // A second touch/pen elsewhere must not move or commit this drag.
    dispatchWindow('pointermove', { clientY: 40, pointerId: 2 })
    await new Promise((resolve) => requestAnimationFrame(resolve))
    dispatchWindow('pointerup', { pointerId: 2 })
    await new Promise((resolve) => requestAnimationFrame(resolve))
    await new Promise((resolve) => requestAnimationFrame(resolve))

    expect(liveRows).toEqual([])
    expect(committedRows).toEqual([])

    // The original pointer can still move and release the drag normally.
    dispatchWindow('pointermove', { clientY: 40, pointerId: 1 })
    await new Promise((resolve) => requestAnimationFrame(resolve))
    dispatchWindow('pointerup', { pointerId: 1 })
    await new Promise((resolve) => requestAnimationFrame(resolve))
    await new Promise((resolve) => requestAnimationFrame(resolve))

    expect(committedRows).toEqual([8])
  })

  it('fits and flushes against the settled geometry, not a stale one, on a release that lands before the next frame applies the final row change', async () => {
    const pane = makeFakePane()
    let flushCount = 0
    pane.container.addEventListener('orca-pane-pty-resize-hold-flush', () => {
      flushCount += 1
    })
    // Stands in for gutterRows-driven DOM geometry that a React state update commits
    // asynchronously — settling on a microtask, later than the synchronous call that
    // requests it, the way batched state does.
    let settledRows = 5
    const fitReadsAt: number[] = []

    beginTerminalDockGutterDrag(
      { clientY: 100, pointerId: 1, currentTarget: makeHandle() },
      {
        pane,
        startGutterRows: 5,
        onLiveRowsChange: (rows) => {
          void Promise.resolve().then(() => {
            settledRows = rows
          })
        },
        onCommit: () => {}
      },
      () => {
        fitReadsAt.push(settledRows)
        queuePanePtyResizeIfHeld(pane.container, 80, settledRows)
        return true
      }
    )

    // Move straight to 8 rows and release before the move's own rAF ever applies it —
    // the queued row change and the release land in the same tick.
    dispatchWindow('pointermove', { clientY: 40 })
    dispatchWindow('pointerup')

    expect(flushCount).toBe(0)

    await new Promise((resolve) => requestAnimationFrame(resolve))

    expect(fitReadsAt).toEqual([8])
    expect(flushCount).toBe(1)
  })
})
