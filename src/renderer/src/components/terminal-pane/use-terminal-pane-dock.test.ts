// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { Tab } from '../../../../shared/types'

type FakeState = {
  unifiedTabsByWorktree: Record<string, Tab[]>
  settings: { experimentalTerminalDock?: boolean; keybindings?: unknown } | undefined
  keybindings: Record<string, string[]>
  agentStatusByPaneKey: Record<string, { state?: string; agentType?: string } | undefined>
  setTabTerminalDockState: (
    tabId: string,
    patch: { paneKey: string; docked?: boolean; gutterRows?: number }
  ) => void
}

function makeUnifiedTab(overrides: Partial<Tab>): Tab {
  return {
    id: 'unified-1',
    entityId: 'tab-1',
    groupId: 'group-1',
    worktreeId: 'wt-1',
    contentType: 'terminal',
    label: 'Terminal',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    terminalDockByPaneKey: {},
    ...overrides
  } as Tab
}

// Why: vi.mock's factory is hoisted above ordinary top-level consts, so the fake store this
// test drives (and the spy it asserts against) both have to be built inside vi.hoisted.
const mocks = vi.hoisted(() => {
  const setTabTerminalDockState = () => {}
  return { setTabTerminalDockState }
})

vi.mock('@/store', () => {
  const fakeStore = create<FakeState>(() => ({
    unifiedTabsByWorktree: {},
    settings: { experimentalTerminalDock: true },
    keybindings: {},
    agentStatusByPaneKey: {},
    setTabTerminalDockState: mocks.setTabTerminalDockState
  }))
  return { useAppStore: fakeStore }
})

import { useAppStore as realUseAppStore } from '@/store'
import { useTerminalPaneDock } from './use-terminal-pane-dock'

// why: vi.mock swaps the runtime value, not the static type — re-cast to the fake shape.
const fakeStore = realUseAppStore as unknown as UseBoundStore<StoreApi<FakeState>>

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF_ID}`

beforeEach(() => {
  mocks.setTabTerminalDockState = vi.fn()
  fakeStore.setState({
    setTabTerminalDockState: mocks.setTabTerminalDockState,
    unifiedTabsByWorktree: {
      'wt-1': [
        makeUnifiedTab({ terminalDockByPaneKey: { [PANE_KEY]: { docked: true, gutterRows: 5 } } })
      ]
    }
  })
})

function renderDockHook(enabled: boolean) {
  return renderHook(() =>
    useTerminalPaneDock({
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      enabled,
      managerRef: { current: null },
      containerRef: { current: null }
    })
  )
}

// Why: the dock's window-level keydown listener only reacts inside its owning pane's
// container, so exercising the shortcut needs a real DOM node and an active-pane stub.
function renderDockHookWithShortcutTarget(): {
  container: HTMLDivElement
  result: ReturnType<typeof renderHook<ReturnType<typeof useTerminalPaneDock>, unknown>>['result']
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const { result } = renderHook(() =>
    useTerminalPaneDock({
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      enabled: true,
      managerRef: {
        current: { getActivePane: () => ({ leafId: LEAF_ID, terminal: { focus: () => {} } }) }
      } as never,
      containerRef: { current: container }
    })
  )
  return { container, result }
}

function dispatchPassthroughToggle(container: HTMLDivElement): void {
  container.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'p',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true
    })
  )
}

describe('useTerminalPaneDock', () => {
  it('undocks on confirmed agent exit when the pane was docked', () => {
    const { result } = renderDockHook(true)
    act(() => {
      result.current.undockOnConfirmedAgentExit(LEAF_ID)
    })
    expect(mocks.setTabTerminalDockState).toHaveBeenCalledExactlyOnceWith('unified-1', {
      paneKey: PANE_KEY,
      docked: false
    })
  })

  it('never writes dock state when the flag is disabled, even to clean up a stale docked pane', () => {
    const { result } = renderDockHook(false)
    act(() => {
      result.current.undockOnConfirmedAgentExit(LEAF_ID)
    })
    expect(mocks.setTabTerminalDockState).not.toHaveBeenCalled()
  })

  it('reads persisted docked/gutterRows from the unified tab record', () => {
    const { result } = renderDockHook(true)
    expect(result.current.isPaneDocked(PANE_KEY)).toBe(true)
    expect(result.current.gutterRowsFor(PANE_KEY)).toBe(5)
    expect(result.current.paneDockOwnsFocus(PANE_KEY)).toBe(true)
  })

  it('paneDockOwnsFocus is false when disabled even for a persisted docked pane', () => {
    const { result } = renderDockHook(false)
    expect(result.current.paneDockOwnsFocus(PANE_KEY)).toBe(false)
  })

  it('resolves the dock toggle shortcut from the live keybindings registry, not settings.keybindings', () => {
    // A stale override on the legacy field must have no effect, and an empty override on the
    // live registry (an actual rebind result) must be honored — proving which source is read.
    fakeStore.setState({
      settings: { experimentalTerminalDock: true, keybindings: { 'terminal.dock.toggle': [] } },
      keybindings: {}
    })
    const { container } = renderDockHookWithShortcutTarget()

    container.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'k',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true
      })
    )

    expect(mocks.setTabTerminalDockState).toHaveBeenCalledExactlyOnceWith('unified-1', {
      paneKey: PANE_KEY,
      docked: false
    })
  })

  it('seeds the previous agent state on passthrough entry, so the first working->done transition auto-exits', () => {
    fakeStore.setState({
      agentStatusByPaneKey: { [PANE_KEY]: { state: 'working', agentType: 'claude' } }
    })
    const { container, result } = renderDockHookWithShortcutTarget()

    act(() => dispatchPassthroughToggle(container))
    expect(result.current.isPanePassthrough(PANE_KEY)).toBe(true)

    // The only status change observed since entering passthrough — without a seed, this
    // reads as a transition from an unknown (null) previous state and never auto-exits.
    act(() => {
      fakeStore.setState({
        agentStatusByPaneKey: { [PANE_KEY]: { state: 'done', agentType: 'claude' } }
      })
    })

    expect(result.current.isPanePassthrough(PANE_KEY)).toBe(false)
  })

  it('prunes passthrough membership and auto-exit tracking when a pane retires', () => {
    fakeStore.setState({
      agentStatusByPaneKey: { [PANE_KEY]: { state: 'working', agentType: 'claude' } }
    })
    const { container, result } = renderDockHookWithShortcutTarget()

    act(() => dispatchPassthroughToggle(container))
    expect(result.current.isPanePassthrough(PANE_KEY)).toBe(true)

    act(() => result.current.prunePassthroughForRetiredPane(LEAF_ID))

    expect(result.current.isPanePassthrough(PANE_KEY)).toBe(false)
  })
})
