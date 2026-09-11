import { afterEach, describe, expect, it, vi } from 'vitest'
import { UNCOVERED_TERMINAL_LEAF_SELECTOR } from '@/components/terminal-pane/native-chat-covered-pane'
import { focusTerminalTabSurface } from '../focus-terminal-tab-surface'

const mocks = vi.hoisted(() => ({
  refreshTerminalImeInputContext: vi.fn()
}))

vi.mock('@/components/terminal-pane/terminal-ime-input-context-refresh', () => ({
  refreshTerminalImeInputContext: mocks.refreshTerminalImeInputContext
}))

function stubAnimationFrames(): () => void {
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  return () => {
    frames.shift()?.(0)
    frames.shift()?.(0)
  }
}

function focusTabWithSurface(surface: object): void {
  // Why: the tab-wide lookup is scoped to uncovered leaves, so the stub has to
  // answer the same selector the implementation builds, not a bare descendant one.
  const helperSelector = `[data-terminal-tab-id="tab-1"] ${UNCOVERED_TERMINAL_LEAF_SELECTOR} .xterm-helper-textarea`
  vi.stubGlobal('document', {
    querySelector: vi.fn((selector: string) => (selector === helperSelector ? surface : null)),
    querySelectorAll: vi.fn(() => [])
  })
  const flushAnimationFrames = stubAnimationFrames()
  focusTerminalTabSurface('tab-1', null, { refreshImeContext: true })
  flushAnimationFrames()
}

afterEach(() => {
  mocks.refreshTerminalImeInputContext.mockClear()
  vi.unstubAllGlobals()
})

describe('focusTerminalTabSurface dock redirect', () => {
  it('focuses the enabled dock composer without refreshing xterm input context', () => {
    const composer = { focus: vi.fn() }
    const pane = { querySelector: vi.fn(() => composer) }
    const surface = { focus: vi.fn(), closest: vi.fn(() => pane) }

    focusTabWithSurface(surface)

    expect(composer.focus).toHaveBeenCalledOnce()
    expect(surface.focus).not.toHaveBeenCalled()
    expect(mocks.refreshTerminalImeInputContext).not.toHaveBeenCalled()
  })

  it('falls back to xterm when the dock has no enabled composer', () => {
    const pane = { querySelector: vi.fn(() => null) }
    const surface = { focus: vi.fn(), closest: vi.fn(() => pane) }

    focusTabWithSurface(surface)

    expect(surface.focus).toHaveBeenCalledOnce()
    expect(mocks.refreshTerminalImeInputContext).toHaveBeenCalledWith(surface, {
      onRefocusSkipped: undefined
    })
  })
})
