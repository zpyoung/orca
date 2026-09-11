import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { focusActivePane } from '../pane-helpers'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

class FakeHTMLElement {}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('focusActivePane dock fallback', () => {
  it('focuses xterm when dock ownership is stale and no enabled composer exists', () => {
    vi.stubGlobal('HTMLElement', FakeHTMLElement)
    vi.stubGlobal('document', {
      activeElement: null,
      querySelector: vi.fn(() => null)
    })
    const terminal = { focus: vi.fn() }
    const pane = {
      leafId: LEAF_ID,
      terminal,
      container: { querySelector: vi.fn(() => null) }
    }
    const manager = {
      getActivePane: vi.fn(() => pane),
      getPanes: vi.fn(() => [pane])
    } as unknown as PaneManager

    focusActivePane(manager, {
      tabId: 'tab-1',
      paneDockOwnsFocus: vi.fn(() => true)
    })

    expect(terminal.focus).toHaveBeenCalledOnce()
  })
})
