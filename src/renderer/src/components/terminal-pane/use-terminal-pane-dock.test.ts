// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { Tab } from '../../../../shared/types'

type FakeState = {
  unifiedTabsByWorktree: Record<string, Tab[]>
  settings: { experimentalTerminalDock?: boolean; keybindings?: unknown } | undefined
  agentStatusByPaneKey: Record<string, { state?: string; agentType?: string }>
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
    agentStatusByPaneKey: {},
    setTabTerminalDockState: mocks.setTabTerminalDockState
  }))
  return { useAppStore: fakeStore }
})

import { useAppStore as fakeStore } from '@/store'
import { useTerminalPaneDock } from './use-terminal-pane-dock'

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
})
