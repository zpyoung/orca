import { describe, expect, it } from 'vitest'
import {
  findKeybindingConflicts,
  getKeybindingDefinition,
  KEYBINDING_DEFINITIONS
} from '../keybindings'

describe('terminal dock keybindings', () => {
  it('registers terminal.dock.toggle with Mod+Shift+K on every platform', () => {
    const definition = getKeybindingDefinition('terminal.dock.toggle')
    expect(definition).not.toBeNull()
    expect(definition?.group).toBe('Terminal Panes')
    expect(definition?.scope).toBe('terminal')
    expect(definition?.defaultBindings).toEqual({
      darwin: ['Mod+Shift+K'],
      linux: ['Mod+Shift+K'],
      win32: ['Mod+Shift+K']
    })
  })

  it('registers terminal.dock.passthrough with Mod+Shift+P on every platform', () => {
    const definition = getKeybindingDefinition('terminal.dock.passthrough')
    expect(definition).not.toBeNull()
    expect(definition?.group).toBe('Terminal Panes')
    expect(definition?.scope).toBe('terminal')
    expect(definition?.defaultBindings).toEqual({
      darwin: ['Mod+Shift+P'],
      linux: ['Mod+Shift+P'],
      win32: ['Mod+Shift+P']
    })
  })

  // findKeybindingConflicts buckets by scope, so it cannot see a terminal-scoped
  // chord shadowing a global one inside terminal panes. Check the chords directly.
  it.each([
    ['terminal.dock.toggle', 'Mod+Shift+K'],
    ['terminal.dock.passthrough', 'Mod+Shift+P']
  ])('claims %s chord %s in no other scope', (actionId, chord) => {
    const otherClaimants = KEYBINDING_DEFINITIONS.filter(
      (definition) =>
        definition.id !== actionId &&
        (['darwin', 'linux', 'win32'] as const).some((platform) =>
          definition.defaultBindings[platform].includes(chord)
        )
    ).map((definition) => definition.id)
    expect(otherClaimants).toEqual([])
  })

  it('introduces no default-binding conflicts within the terminal scope', () => {
    expect(
      findKeybindingConflicts(
        'darwin',
        {},
        { relevantActionIds: ['terminal.dock.toggle', 'terminal.dock.passthrough'] }
      )
    ).toEqual([])
    expect(
      findKeybindingConflicts(
        'linux',
        {},
        { relevantActionIds: ['terminal.dock.toggle', 'terminal.dock.passthrough'] }
      )
    ).toEqual([])
    expect(
      findKeybindingConflicts(
        'win32',
        {},
        { relevantActionIds: ['terminal.dock.toggle', 'terminal.dock.passthrough'] }
      )
    ).toEqual([])
  })
})
