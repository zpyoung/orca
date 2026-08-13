// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { shouldRepairActiveTerminalTab } from '@/components/terminal/active-terminal-repair'
import { activateTabNumberShortcut } from './tab-number-shortcuts'
import { activatePipelineTabPaletteResult } from './pipeline-tab-palette-activation'
import { activateCyclableTab } from '../hooks/ipc-tab-switch'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/runtime/web-runtime-session', () => ({
  activateWebRuntimeSessionTab: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(() => false)
}))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))
vi.mock('./worktree-activation', () => ({ activateAndRevealWorktree: vi.fn(() => true) }))

const initialAppState = useAppStore.getInitialState()

const WT = 'wt-1'
const TERMINAL_TAB = { id: 'term-tab-1', groupId: 'group-1', entityId: 'term-tab-1' }
const PIPELINE_TAB = { id: 'pipe-tab-1', groupId: 'group-1', entityId: 'run-1' }

// a workspace with one real terminal tab and one pipeline tab sharing a group,
// the terminal already focused — the state every activation route below starts from.
function seedWorkspaceWithActiveTerminalAndAPipelineTab(): void {
  useAppStore.setState(
    {
      ...initialAppState,
      activeView: 'terminal',
      activeWorktreeId: WT,
      activeGroupIdByWorktree: { [WT]: 'group-1' },
      groupsByWorktree: {
        [WT]: [
          {
            id: 'group-1',
            worktreeId: WT,
            activeTabId: TERMINAL_TAB.id,
            tabOrder: [TERMINAL_TAB.id, PIPELINE_TAB.id]
          }
        ]
      },
      unifiedTabsByWorktree: {
        [WT]: [
          {
            id: TERMINAL_TAB.id,
            entityId: TERMINAL_TAB.entityId,
            groupId: 'group-1',
            worktreeId: WT,
            contentType: 'terminal',
            label: 'Terminal 1',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          },
          {
            id: PIPELINE_TAB.id,
            entityId: PIPELINE_TAB.entityId,
            groupId: 'group-1',
            worktreeId: WT,
            contentType: 'pipeline',
            label: 'bugfix-fast #1',
            customLabel: null,
            color: null,
            sortOrder: 1,
            createdAt: 0
          }
        ]
      },
      tabsByWorktree: {
        [WT]: [
          {
            id: TERMINAL_TAB.id,
            ptyId: null,
            worktreeId: WT,
            title: 'Terminal 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      },
      activeTabId: TERMINAL_TAB.id,
      activeTabIdByWorktree: { [WT]: TERMINAL_TAB.id },
      activeTabType: 'terminal',
      activeTabTypeByWorktree: { [WT]: 'terminal' },
      repos: [{ id: 'repo-1', connectionId: null, executionHostId: 'local' }] as never,
      worktreesByRepo: { 'repo-1': [{ id: WT, repoId: 'repo-1' }] } as never
    } as never,
    true
  )
}

// the invariant under test: once a pipeline tab is the focused surface, no
// terminal-scoped id may still point at the terminal that was active before —
// neither directly, nor after a repair pass runs against the resulting state.
function expectTerminalNoLongerTargeted(): void {
  const state = useAppStore.getState()
  expect(state.activeTabIdByWorktree[WT]).not.toBe(TERMINAL_TAB.id)
  expect(state.activeTabId).not.toBe(TERMINAL_TAB.id)

  const repairs = shouldRepairActiveTerminalTab({
    activeTabType: state.activeTabTypeByWorktree[WT] ?? state.activeTabType,
    activeTabId: state.activeTabIdByWorktree[WT] ?? null,
    tabs: state.tabsByWorktree[WT] ?? []
  })
  expect(repairs).toBe(false)
}

describe('activating a pipeline tab never leaves a terminal-scoped action able to reach the prior terminal', () => {
  afterEach(() => {
    useAppStore.setState(initialAppState, true)
  })

  it('via the number-shortcut route', () => {
    seedWorkspaceWithActiveTerminalAndAPipelineTab()

    expect(activateTabNumberShortcut(1)).toBe(true)

    expectTerminalNoLongerTargeted()
  })

  it('via the cross-type cycle route (Ctrl+Shift+[ / ])', () => {
    seedWorkspaceWithActiveTerminalAndAPipelineTab()
    const store = useAppStore.getState()

    activateCyclableTab(store, { type: 'pipeline', id: PIPELINE_TAB.entityId, tabId: PIPELINE_TAB.id })

    expectTerminalNoLongerTargeted()
  })

  it('via the jump-palette route', () => {
    seedWorkspaceWithActiveTerminalAndAPipelineTab()

    activatePipelineTabPaletteResult({ tabId: PIPELINE_TAB.id, worktreeId: WT })

    expectTerminalNoLongerTargeted()
  })
})
