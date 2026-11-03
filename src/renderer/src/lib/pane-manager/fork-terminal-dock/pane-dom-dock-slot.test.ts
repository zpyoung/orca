// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { TerminalLeafId } from '../../../../../shared/stable-pane-id'
import { createPaneDOM } from '../pane-dom-creation'
import { shouldFocusTerminalFromPanePointerDown } from '../pane-pointer-focus'

const csiHandlers = vi.hoisted(() => new Map<string, (params: (number | number[])[]) => boolean>())

const webLinksAddonMock = vi.hoisted(() => ({
  handler: null as ((event: MouseEvent, uri: string) => void) | null,
  options: null as { hover?: (event: MouseEvent, uri: string) => void; leave?: () => void } | null
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(function FitAddon() {
    return {}
  })
}))

vi.mock('@xterm/addon-search', () => ({
  SearchAddon: vi.fn().mockImplementation(function SearchAddon() {
    return {}
  })
}))

vi.mock('@xterm/addon-serialize', () => ({
  SerializeAddon: vi.fn().mockImplementation(function SerializeAddon() {
    return {}
  })
}))

vi.mock('@xterm/addon-unicode11', () => ({
  Unicode11Addon: vi.fn().mockImplementation(function Unicode11Addon() {
    return {}
  })
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: vi.fn().mockImplementation(function WebLinksAddon(handler, options) {
    webLinksAddonMock.handler = handler
    webLinksAddonMock.options = options
    return {}
  })
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(function Terminal() {
    return {
      options: {},
      loadAddon: vi.fn(),
      registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
      open: vi.fn(),
      parser: {
        registerCsiHandler: vi.fn(
          (id: { final: string }, handler: (params: (number | number[])[]) => boolean) => {
            csiHandlers.set(id.final, handler)
            return { dispose: vi.fn() }
          }
        ),
        registerEscHandler: vi.fn(() => ({ dispose: vi.fn() }))
      }
    }
  })
}))

describe('createPaneDOM dock slot', () => {
  const leafId = '11111111-1111-4111-8111-111111111111' as TerminalLeafId

  function makePane() {
    const pane = createPaneDOM(
      1,
      leafId,
      { linkOpenHint: () => 'open hint' },
      { active: null } as never,
      {} as never,
      vi.fn(),
      vi.fn()
    )
    const { dockContainer } = pane
    if (!dockContainer) {
      throw new Error('Expected createPaneDOM to create a dock slot')
    }
    return { pane, dockContainer }
  }

  it('appends the dock slot to container as a sibling after xtermContainer', () => {
    const { pane, dockContainer } = makePane()

    expect(dockContainer.parentElement).toBe(pane.container)
    const children = Array.from(pane.container.children)
    expect(children.indexOf(dockContainer)).toBeGreaterThan(children.indexOf(pane.xtermContainer))
  })

  it('gives the dock slot a stable class name', () => {
    const { dockContainer } = makePane()

    expect(dockContainer.classList.contains('pane-dock-slot')).toBe(true)
  })

  it('declares data-pane-prevent-terminal-focus on the dock slot', () => {
    const { dockContainer } = makePane()

    expect(dockContainer.hasAttribute('data-pane-prevent-terminal-focus')).toBe(true)
  })

  it('is honored by shouldFocusTerminalFromPanePointerDown for pointer targets inside the slot', () => {
    const { dockContainer } = makePane()
    const childInsideDock = document.createElement('span')
    dockContainer.appendChild(childInsideDock)

    expect(shouldFocusTerminalFromPanePointerDown(childInsideDock)).toBe(false)
  })

  it('exposes the dock slot on the pane record', () => {
    const { pane } = makePane()

    expect(pane.dockContainer).toBeInstanceOf(HTMLElement)
  })
})
