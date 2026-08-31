import { describe, expect, it } from 'vitest'
import { shouldDockTerminalComposerByDefault } from './terminal-dock-initial-state'

describe('shouldDockTerminalComposerByDefault', () => {
  it('docks recognized TUI agents behind the flag', () => {
    expect(
      shouldDockTerminalComposerByDefault({
        enabled: true,
        autoDockNewPanes: true,
        agent: 'gemini',
        hasPersistedDecision: false
      })
    ).toBe(true)
  })

  it('preserves persisted decisions and rejects disabled or custom agents', () => {
    expect(
      shouldDockTerminalComposerByDefault({
        enabled: true,
        autoDockNewPanes: true,
        agent: 'claude',
        hasPersistedDecision: true
      })
    ).toBe(false)
    expect(
      shouldDockTerminalComposerByDefault({
        enabled: false,
        autoDockNewPanes: true,
        agent: 'claude',
        hasPersistedDecision: false
      })
    ).toBe(false)
    expect(
      shouldDockTerminalComposerByDefault({
        enabled: true,
        autoDockNewPanes: true,
        agent: 'custom-agent',
        hasPersistedDecision: false
      })
    ).toBe(false)
  })

  it('does not dock a fresh recognized pane when automatic opening is off', () => {
    expect(
      shouldDockTerminalComposerByDefault({
        enabled: true,
        autoDockNewPanes: false,
        agent: 'claude',
        hasPersistedDecision: false
      })
    ).toBe(false)
  })

  it('does not dock a persisted pane when automatic opening is off', () => {
    expect(
      shouldDockTerminalComposerByDefault({
        enabled: true,
        autoDockNewPanes: false,
        agent: 'claude',
        hasPersistedDecision: true
      })
    ).toBe(false)
  })
})
