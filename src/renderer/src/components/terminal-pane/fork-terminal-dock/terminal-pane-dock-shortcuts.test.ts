import { describe, expect, it } from 'vitest'
import { resolveTerminalDockShortcutAction } from './terminal-pane-dock-shortcuts'

const macMod = { metaKey: true, ctrlKey: false, altKey: false, shiftKey: true }
const winMod = { metaKey: false, ctrlKey: true, altKey: false, shiftKey: true }

describe('resolveTerminalDockShortcutAction', () => {
  it('resolves the dock toggle on Mod+Shift+K per platform', () => {
    expect(resolveTerminalDockShortcutAction({ key: 'k', ...macMod }, 'darwin')).toBe('toggleDock')
    expect(resolveTerminalDockShortcutAction({ key: 'k', ...winMod }, 'win32')).toBe('toggleDock')
    expect(resolveTerminalDockShortcutAction({ key: 'k', ...winMod }, 'linux')).toBe('toggleDock')
  })

  it('resolves the passthrough toggle on Mod+Shift+P', () => {
    expect(resolveTerminalDockShortcutAction({ key: 'p', ...macMod }, 'darwin')).toBe(
      'togglePassthrough'
    )
  })

  it('ignores key repeat', () => {
    expect(
      resolveTerminalDockShortcutAction({ key: 'k', ...macMod, repeat: true }, 'darwin')
    ).toBeNull()
  })

  it('returns null for unrelated chords, including Escape', () => {
    expect(resolveTerminalDockShortcutAction({ key: 'Escape' }, 'darwin')).toBeNull()
    expect(resolveTerminalDockShortcutAction({ key: 'k', metaKey: true }, 'darwin')).toBeNull()
  })
})
