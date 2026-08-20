import { describe, expect, it } from 'vitest'
import { DEFAULT_TERMINAL_DOCK_PANE_STATE } from './terminal-dock-pane-state'
import { resolveTerminalDockPaneState } from './resolve-terminal-dock-pane-state'

const HOST_STATE = { docked: true, gutterRows: 8 }
const LOCAL_STATE = { docked: false, gutterRows: 10 }

describe('resolveTerminalDockPaneState', () => {
  it('prefers the host/store value once the host has ever echoed the field', () => {
    expect(resolveTerminalDockPaneState(HOST_STATE, LOCAL_STATE, true)).toEqual(HOST_STATE)
  })

  it('falls back to the default when the host has echoed but has no value for this pane', () => {
    expect(resolveTerminalDockPaneState(undefined, LOCAL_STATE, true)).toEqual(
      DEFAULT_TERMINAL_DOCK_PANE_STATE
    )
  })

  it('uses the local fallback when the host has never echoed the field', () => {
    expect(resolveTerminalDockPaneState(undefined, LOCAL_STATE, false)).toEqual(LOCAL_STATE)
  })

  it('ignores a stray host value when the host has never echoed for this tab', () => {
    // Shouldn't happen in practice (hostEverEchoed derives from the same record), but the
    // "ever echoed" flag — not raw host-value presence — must be what governs precedence.
    expect(resolveTerminalDockPaneState(HOST_STATE, LOCAL_STATE, false)).toEqual(LOCAL_STATE)
  })

  it('defaults when neither the host nor the local fallback has a value', () => {
    expect(resolveTerminalDockPaneState(undefined, undefined, false)).toEqual(
      DEFAULT_TERMINAL_DOCK_PANE_STATE
    )
    expect(resolveTerminalDockPaneState(undefined, undefined, true)).toEqual(
      DEFAULT_TERMINAL_DOCK_PANE_STATE
    )
  })
})
