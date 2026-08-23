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

function findSwitch(node: unknown): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (typeof entry.props.checked === 'boolean' && typeof entry.props.onChange === 'function') {
      found = entry
    }
  })
  if (!found) {
    throw new Error('terminal dock switch not found')
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

    expect(findSwitch(element).props.checked).toBe(false)
  })

  it('reflects the persisted flag', () => {
    const element = TerminalDockExperimentalSetting({
      settings: terminalDockSettings({ experimentalTerminalDock: true }),
      updateSettings: vi.fn()
    })

    expect(findSwitch(element).props.checked).toBe(true)
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
    const onChange = findSwitch(element).props.onChange as () => void

    onChange()

    expect(updateSettings).toHaveBeenCalledWith({ experimentalTerminalDock: true })
  })

  it('disables the flag from on', () => {
    const updateSettings = vi.fn()
    const element = TerminalDockExperimentalSetting({
      settings: terminalDockSettings({ experimentalTerminalDock: true }),
      updateSettings
    })
    const onChange = findSwitch(element).props.onChange as () => void

    onChange()

    expect(updateSettings).toHaveBeenCalledWith({ experimentalTerminalDock: false })
  })
})
