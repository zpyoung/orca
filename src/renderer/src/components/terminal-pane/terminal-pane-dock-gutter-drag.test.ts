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

function dispatchWindow(type: string, init: Partial<{ clientY: number }> = {}): void {
  const event = new Event(type) as PointerEvent
  Object.defineProperty(event, 'clientY', { value: init.clientY ?? 0 })
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
})
