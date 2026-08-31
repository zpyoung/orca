import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { focusRuntimeTerminalSurface, registerRuntimeTerminalTab } from '../sync-runtime-graph'

const FOCUS_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const runtimeFocusTabDisposers: (() => void)[] = []

function registerRuntimeFocusTab(tabId: string, hasComposer: boolean) {
  const composer = { focus: vi.fn() }
  const terminal = { focus: vi.fn() }
  const container = {
    querySelector: vi.fn(() => (hasComposer ? composer : null))
  } as unknown as HTMLElement
  const pane = { id: 7, leafId: FOCUS_LEAF_ID, container, terminal }
  const manager = {
    getActivePane: vi.fn(() => pane),
    getNumericIdForLeaf: vi.fn((leafId: string) => (leafId === FOCUS_LEAF_ID ? 7 : null)),
    getPanes: vi.fn(() => [pane]),
    setActivePane: vi.fn()
  } as unknown as PaneManager
  runtimeFocusTabDisposers.push(
    registerRuntimeTerminalTab({
      tabId,
      worktreeId: 'worktree-1',
      getManager: () => manager,
      getContainer: () => null,
      getPtyIdForPane: () => null,
      getTabWideAgentHintLeafId: () => null
    })
  )
  return { composer, manager, terminal }
}

afterEach(() => {
  for (const dispose of runtimeFocusTabDisposers.splice(0)) {
    dispose()
  }
})

describe('focusRuntimeTerminalSurface', () => {
  it('focuses the dock composer for a resolved leaf', () => {
    const { composer, manager, terminal } = registerRuntimeFocusTab('tab-dock-leaf', true)

    expect(focusRuntimeTerminalSurface('tab-dock-leaf', FOCUS_LEAF_ID)).toBe(true)
    expect(manager.setActivePane).toHaveBeenCalledWith(7, { focus: false })
    expect(composer.focus).toHaveBeenCalledOnce()
    expect(terminal.focus).not.toHaveBeenCalled()
  })

  it('falls back to the terminal for a resolved leaf without a composer', () => {
    const { manager, terminal } = registerRuntimeFocusTab('tab-terminal-leaf', false)

    expect(focusRuntimeTerminalSurface('tab-terminal-leaf', FOCUS_LEAF_ID)).toBe(true)
    expect(manager.setActivePane).toHaveBeenCalledWith(7, { focus: false })
    expect(terminal.focus).toHaveBeenCalledOnce()
  })

  it('focuses the active pane composer when no leaf is requested', () => {
    const { composer, manager, terminal } = registerRuntimeFocusTab('tab-dock-active', true)

    expect(focusRuntimeTerminalSurface('tab-dock-active')).toBe(true)
    expect(manager.setActivePane).not.toHaveBeenCalled()
    expect(composer.focus).toHaveBeenCalledOnce()
    expect(terminal.focus).not.toHaveBeenCalled()
  })

  it('returns false for an unregistered terminal tab', () => {
    expect(focusRuntimeTerminalSurface('tab-missing')).toBe(false)
  })
})
