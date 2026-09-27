import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { getDefaultSettings } from '../../../../../shared/constants'
import { TerminalDockExperimentalSetting } from './TerminalDockExperimentalSetting'

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function visit(node: unknown, cb: (node: ReactElementLike) => void): void {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return
  }
  if (Array.isArray(node)) {
    node.forEach((entry) => visit(entry, cb))
    return
  }
  const element = node as ReactElementLike
  cb(element)
  if (element.props?.children) {
    visit(element.props.children, cb)
  }
}

function findSwitch(node: unknown, ariaLabel: string): ReactElementLike | null {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (
      entry.props.ariaLabel === ariaLabel &&
      typeof entry.props.checked === 'boolean' &&
      typeof entry.props.onChange === 'function'
    ) {
      found = entry
    }
  })
  return found
}

function requireSwitch(node: unknown, ariaLabel: string): ReactElementLike {
  const found = findSwitch(node, ariaLabel)
  if (!found) {
    throw new Error(`${ariaLabel} switch not found`)
  }
  return found
}

function terminalDockSettings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return { ...getDefaultSettings('/tmp'), ...overrides }
}

describe('TerminalDockExperimentalSetting', () => {
  it('is off by default', () => {
    const element = TerminalDockExperimentalSetting({
      settings: terminalDockSettings(),
      updateSettings: vi.fn()
    })

    expect(requireSwitch(element, 'Toggle terminal dock').props.checked).toBe(false)
  })

  it('reflects the persisted flag', () => {
    const element = TerminalDockExperimentalSetting({
      settings: terminalDockSettings({ experimentalTerminalDock: true }),
      updateSettings: vi.fn()
    })

    expect(requireSwitch(element, 'Toggle terminal dock').props.checked).toBe(true)
  })

  it('labels the setting in the settings pane', () => {
    const markup = renderToStaticMarkup(
      <TerminalDockExperimentalSetting settings={terminalDockSettings()} updateSettings={vi.fn()} />
    )

    expect(markup).toContain('Terminal dock')
  })

  it('enables the flag from off', () => {
    const updateSettings = vi.fn()
    const element = TerminalDockExperimentalSetting({
      settings: terminalDockSettings(),
      updateSettings
    })
    const onChange = requireSwitch(element, 'Toggle terminal dock').props.onChange as () => void

    onChange()

    expect(updateSettings).toHaveBeenCalledWith({ experimentalTerminalDock: true })
  })

  it('disables the flag from on', () => {
    const updateSettings = vi.fn()
    const element = TerminalDockExperimentalSetting({
      settings: terminalDockSettings({ experimentalTerminalDock: true }),
      updateSettings
    })
    const onChange = requireSwitch(element, 'Toggle terminal dock').props.onChange as () => void

    onChange()

    expect(updateSettings).toHaveBeenCalledWith({ experimentalTerminalDock: false })
  })

  it('hides automatic opening while the terminal dock is off', () => {
    const element = TerminalDockExperimentalSetting({
      settings: terminalDockSettings(),
      updateSettings: vi.fn()
    })

    expect(findSwitch(element, 'Toggle automatic terminal dock opening')).toBeNull()
  })

  it.each([
    ['an older settings blob', undefined],
    ['an explicit enabled value', true]
  ])('shows automatic opening as checked for %s', (_, dockTerminalComposerByDefault) => {
    const element = TerminalDockExperimentalSetting({
      settings: terminalDockSettings({
        experimentalTerminalDock: true,
        dockTerminalComposerByDefault
      }),
      updateSettings: vi.fn()
    })

    expect(requireSwitch(element, 'Toggle automatic terminal dock opening').props.checked).toBe(
      true
    )
  })

  it('shows automatic opening as unchecked when disabled', () => {
    const element = TerminalDockExperimentalSetting({
      settings: terminalDockSettings({
        experimentalTerminalDock: true,
        dockTerminalComposerByDefault: false
      }),
      updateSettings: vi.fn()
    })

    expect(requireSwitch(element, 'Toggle automatic terminal dock opening').props.checked).toBe(
      false
    )
  })

  it.each([
    [true, false],
    [false, true]
  ])('toggles automatic opening from %s to %s', (current, expected) => {
    const updateSettings = vi.fn()
    const element = TerminalDockExperimentalSetting({
      settings: terminalDockSettings({
        experimentalTerminalDock: true,
        dockTerminalComposerByDefault: current
      }),
      updateSettings
    })
    const onChange = requireSwitch(element, 'Toggle automatic terminal dock opening').props
      .onChange as () => void

    onChange()

    expect(updateSettings).toHaveBeenCalledWith({
      dockTerminalComposerByDefault: expected
    })
  })
})
