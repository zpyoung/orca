import { describe, expect, it } from 'vitest'
import { resolveTerminalDockFocusTransition } from './terminal-pane-dock-focus-transition'

describe('resolveTerminalDockFocusTransition', () => {
  it('focuses the composer when a pane docks', () => {
    expect(
      resolveTerminalDockFocusTransition(
        { docked: false, passthroughActive: false },
        { docked: true, passthroughActive: false }
      )
    ).toBe('focus-composer')
  })

  it('focuses the terminal when a pane undocks', () => {
    expect(
      resolveTerminalDockFocusTransition(
        { docked: true, passthroughActive: false },
        { docked: false, passthroughActive: false }
      )
    ).toBe('focus-terminal')
  })

  it('focuses the composer on passthrough exit while still docked', () => {
    expect(
      resolveTerminalDockFocusTransition(
        { docked: true, passthroughActive: true },
        { docked: true, passthroughActive: false }
      )
    ).toBe('focus-composer')
  })

  it('does nothing on passthrough entry (xterm already owns focus by then)', () => {
    expect(
      resolveTerminalDockFocusTransition(
        { docked: true, passthroughActive: false },
        { docked: true, passthroughActive: true }
      )
    ).toBeNull()
  })

  it('prefers focus-terminal when undocking and exiting passthrough in the same update', () => {
    expect(
      resolveTerminalDockFocusTransition(
        { docked: true, passthroughActive: true },
        { docked: false, passthroughActive: false }
      )
    ).toBe('focus-terminal')
  })

  it('does nothing when nothing changed', () => {
    expect(
      resolveTerminalDockFocusTransition(
        { docked: true, passthroughActive: false },
        { docked: true, passthroughActive: false }
      )
    ).toBeNull()
    expect(
      resolveTerminalDockFocusTransition(
        { docked: false, passthroughActive: false },
        { docked: false, passthroughActive: false }
      )
    ).toBeNull()
  })
})
