import { describe, expect, it } from 'vitest'
import { selectActiveTerminalChromeState } from './active-terminal-chrome-selector'
import type { AppState } from './types'

const WT = 'repo1::/tmp/wt'

function baseState(
  overrides: Partial<
    Pick<
      AppState,
      | 'activeWorktreeId'
      | 'activeTabId'
      | 'activeTabType'
      | 'tabsByWorktree'
      | 'canExpandPaneByTabId'
      | 'expandedPaneByTabId'
    >
  > = {}
): Pick<
  AppState,
  | 'activeWorktreeId'
  | 'activeTabId'
  | 'activeTabType'
  | 'tabsByWorktree'
  | 'canExpandPaneByTabId'
  | 'expandedPaneByTabId'
> {
  return {
    activeWorktreeId: WT,
    activeTabId: null,
    activeTabType: 'terminal',
    tabsByWorktree: {},
    canExpandPaneByTabId: {},
    expandedPaneByTabId: {},
    ...overrides
  }
}

describe('selectActiveTerminalChromeState', () => {
  it('synthesizes tabs[0] as the effective tab when a terminal surface has no active id yet', () => {
    const state = baseState({
      tabsByWorktree: { [WT]: [{ id: 'term-1' } as AppState['tabsByWorktree'][string][number]] }
    })

    const result = selectActiveTerminalChromeState(state)

    expect(result.effectiveActiveTabId).toBe('term-1')
  })

  // Regression: a pipeline-focused worktree leaves activeTabId null with a real terminal tab
  // still in the list. Synthesizing tabs[0] here would let the titlebar collapse-pane control
  // act on a terminal that isn't the visible surface (#round-4 sibling bug).
  it('does not synthesize tabs[0] when no visible tab type is focused, even with a real terminal tab present', () => {
    const state = baseState({
      activeTabType: null,
      activeTabId: null,
      tabsByWorktree: { [WT]: [{ id: 'term-1' } as AppState['tabsByWorktree'][string][number]] }
    })

    const result = selectActiveTerminalChromeState(state)

    expect(result.effectiveActiveTabId).toBeNull()
    expect(result.activeTabCanExpand).toBe(false)
  })

  it('still exposes the active terminal id when a terminal surface really is focused', () => {
    const state = baseState({
      activeTabType: 'terminal',
      activeTabId: 'term-1',
      tabsByWorktree: { [WT]: [{ id: 'term-1' } as AppState['tabsByWorktree'][string][number]] },
      canExpandPaneByTabId: { 'term-1': true }
    })

    const result = selectActiveTerminalChromeState(state)

    expect(result.effectiveActiveTabId).toBe('term-1')
    expect(result.activeTabCanExpand).toBe(true)
  })
})
