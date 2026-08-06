import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/types'
import { getDefaultSettings } from '../../../../shared/constants'
import { NativeChatExperimentalSetting } from './NativeChatExperimentalSetting'

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

/** The width control is the only Select carrying a width-tier value, so match on
 *  that rather than on element order, which shifts as rows are added. */
function findWidthSelect(node: unknown): ReactElementLike {
  const tiers = new Set(['narrow', 'comfortable', 'wide', 'full'])
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (
      typeof entry.props.value === 'string' &&
      tiers.has(entry.props.value) &&
      typeof entry.props.onValueChange === 'function'
    ) {
      found = entry
    }
  })
  if (!found) {
    throw new Error('native chat width select not found')
  }
  return found
}

function nativeChatSettings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return { ...getDefaultSettings('/tmp'), experimentalNativeChat: true, ...overrides }
}

describe('NativeChatExperimentalSetting width control', () => {
  it('offers every width tier once the chat UI is enabled', () => {
    const element = NativeChatExperimentalSetting({
      settings: nativeChatSettings(),
      updateSettings: vi.fn()
    })

    // Options live in a portaled, closed SelectContent, so they are only
    // reachable through the element tree — not the rendered markup.
    const options: { value: string; label: unknown }[] = []
    visit(findWidthSelect(element).props.children, (entry) => {
      if (typeof entry.props.value === 'string' && entry.props.children != null) {
        options.push({ value: entry.props.value, label: entry.props.children })
      }
    })

    expect(options.map((option) => option.value)).toEqual(['narrow', 'comfortable', 'wide', 'full'])
    expect(options.map((option) => option.label)).toEqual(['Narrow', 'Comfortable', 'Wide', 'Full'])
  })

  it('labels the width row in the settings pane', () => {
    const markup = renderToStaticMarkup(
      <NativeChatExperimentalSetting settings={nativeChatSettings()} updateSettings={vi.fn()} />
    )

    expect(markup).toContain('Chat width')
  })

  it('hides the width control while the chat UI is off', () => {
    const markup = renderToStaticMarkup(
      <NativeChatExperimentalSetting
        settings={nativeChatSettings({ experimentalNativeChat: false })}
        updateSettings={vi.fn()}
      />
    )

    expect(markup).not.toContain('Chat width')
  })

  it('reflects the persisted tier', () => {
    const element = NativeChatExperimentalSetting({
      settings: nativeChatSettings({ nativeChatWidth: 'wide' }),
      updateSettings: vi.fn()
    })

    expect(findWidthSelect(element).props.value).toBe('wide')
  })

  it('falls back to comfortable when the setting predates this feature', () => {
    const element = NativeChatExperimentalSetting({
      settings: nativeChatSettings({ nativeChatWidth: undefined }),
      updateSettings: vi.fn()
    })

    expect(findWidthSelect(element).props.value).toBe('comfortable')
  })

  it('writes the chosen tier to the global setting', () => {
    const updateSettings = vi.fn()
    const element = NativeChatExperimentalSetting({
      settings: nativeChatSettings(),
      updateSettings
    })
    const onValueChange = findWidthSelect(element).props.onValueChange as (value: string) => void

    onValueChange('narrow')

    expect(updateSettings).toHaveBeenCalledWith({ nativeChatWidth: 'narrow' })
  })
})
