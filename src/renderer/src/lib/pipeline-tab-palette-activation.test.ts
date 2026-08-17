// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab, TabGroup, Worktree } from '../../../shared/types'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'

const mocks = vi.hoisted(() => ({ activateAndRevealWorktree: vi.fn() }))

vi.mock('./worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

import { activatePipelineTabPaletteResult } from './pipeline-tab-palette-activation'

const initialAppState = useAppStore.getInitialState()

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    repoId: 'repo-1',
    path: '/tmp/wt-1',
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: false,
    displayName: 'Palette Worktree',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function makeTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 'pipe-tab-1',
    entityId: 'run-1',
    groupId: 'group-1',
    worktreeId: 'wt-1',
    contentType: 'pipeline',
    label: 'Deploy Staging #7',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

function makeGroup(overrides: Partial<TabGroup> = {}): TabGroup {
  return {
    id: 'group-1',
    worktreeId: 'wt-1',
    activeTabId: 'pipe-tab-1',
    tabOrder: ['pipe-tab-1'],
    ...overrides
  }
}

function seedStore(overrides: Partial<AppState> = {}): void {
  useAppStore.setState(
    {
      ...initialAppState,
      worktreesByRepo: { 'repo-1': [makeWorktree()] },
      unifiedTabsByWorktree: { 'wt-1': [makeTab()] },
      groupsByWorktree: { 'wt-1': [makeGroup()] },
      activeGroupIdByWorktree: { 'wt-1': 'group-1' },
      activeWorktreeId: 'wt-1',
      activeFileId: null,
      ...overrides
    } as AppState,
    true
  )
}

const target = { tabId: 'pipe-tab-1', worktreeId: 'wt-1' }

describe('activatePipelineTabPaletteResult', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.activateAndRevealWorktree.mockReturnValue(true)
    seedStore()
  })

  it('activates the pipeline tab through the unified-tab store', () => {
    expect(activatePipelineTabPaletteResult(target)).toEqual({
      status: 'activated',
      tabId: 'pipe-tab-1'
    })

    const state = useAppStore.getState()
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-1', {})
    expect(state.activeGroupIdByWorktree['wt-1']).toBe('group-1')
    expect(state.groupsByWorktree['wt-1'][0].activeTabId).toBe('pipe-tab-1')
  })

  it('clears a previously active terminal id instead of leaving it stale or writing the pipeline tab id into terminal state', () => {
    seedStore({
      unifiedTabsByWorktree: {
        'wt-1': [
          makeTab({ id: 'term-tab-1', entityId: 'term-tab-1', contentType: 'terminal' }),
          makeTab()
        ]
      },
      // the group's active tab is still the terminal at the moment activation is
      // requested — activation itself is what must move it to the pipeline tab.
      groupsByWorktree: {
        'wt-1': [makeGroup({ activeTabId: 'term-tab-1', tabOrder: ['term-tab-1', 'pipe-tab-1'] })]
      },
      tabsByWorktree: {
        'wt-1': [
          {
            id: 'term-tab-1',
            ptyId: null,
            worktreeId: 'wt-1',
            title: 'term-tab-1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      },
      activeTabId: 'term-tab-1',
      activeTabIdByWorktree: { 'wt-1': 'term-tab-1' },
      activeTabType: 'terminal'
    })

    activatePipelineTabPaletteResult(target)

    const state = useAppStore.getState()
    expect(state.activeTabIdByWorktree['wt-1']).toBeNull()
    expect(state.activeTabId).toBeNull()
  })

  it('never writes the run id into a file-id field', () => {
    activatePipelineTabPaletteResult(target)

    const state = useAppStore.getState()
    expect(state.activeFileId).toBeNull()
    expect(state.activeFileIdByWorktree['wt-1']).not.toBe('run-1')
  })

  it('threads the execution host of a remote-hosted worktree', () => {
    seedStore({ worktreesByRepo: { 'repo-1': [makeWorktree({ hostId: 'ssh:host-1' })] } })

    expect(activatePipelineTabPaletteResult(target).status).toBe('activated')
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-1', {
      executionHostId: 'ssh:host-1'
    })
  })

  it('picks the host that owns the row when the worktree id exists on two hosts', () => {
    seedStore({
      worktreesByRepo: {
        'repo-1': [makeWorktree({ hostId: 'ssh:host-1' })],
        'repo-2': [makeWorktree({ repoId: 'repo-2', hostId: 'ssh:host-2', path: '/tmp/wt-1-b' })]
      }
    })

    expect(
      activatePipelineTabPaletteResult({ ...target, executionHostId: 'ssh:host-2' }).status
    ).toBe('activated')
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-1', {
      executionHostId: 'ssh:host-2'
    })
  })

  it('reports an unknown worktree without activating', () => {
    seedStore({ worktreesByRepo: {} })

    expect(activatePipelineTabPaletteResult(target)).toEqual({
      status: 'failed',
      reason: 'missing-worktree'
    })
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('focuses the owning group when the tab lives in another split column', () => {
    seedStore({
      unifiedTabsByWorktree: {
        'wt-1': [
          makeTab({ id: 'term-tab-1', contentType: 'terminal' }),
          makeTab({ groupId: 'group-2' })
        ]
      },
      groupsByWorktree: {
        'wt-1': [
          makeGroup({ activeTabId: 'term-tab-1', tabOrder: ['term-tab-1'] }),
          makeGroup({
            id: 'group-2',
            activeTabId: null,
            tabOrder: ['pipe-tab-1']
          })
        ]
      }
    })

    expect(activatePipelineTabPaletteResult(target).status).toBe('activated')

    const state = useAppStore.getState()
    expect(state.activeGroupIdByWorktree['wt-1']).toBe('group-2')
    expect(state.groupsByWorktree['wt-1'][1].activeTabId).toBe('pipe-tab-1')
  })

  it('reports a closed tab as a stale target without touching the worktree', () => {
    seedStore({ unifiedTabsByWorktree: {} })

    expect(activatePipelineTabPaletteResult(target)).toEqual({
      status: 'failed',
      reason: 'missing-tab'
    })
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('rejects a tab id that no longer belongs to a pipeline tab', () => {
    seedStore({
      unifiedTabsByWorktree: { 'wt-1': [makeTab({ contentType: 'terminal' })] }
    })

    expect(activatePipelineTabPaletteResult(target)).toEqual({
      status: 'failed',
      reason: 'missing-tab'
    })
  })

  it('reports a failed worktree activation distinguishably from a stale tab', () => {
    mocks.activateAndRevealWorktree.mockReturnValue(false)

    expect(activatePipelineTabPaletteResult(target)).toEqual({
      status: 'failed',
      reason: 'missing-worktree'
    })
    expect(useAppStore.getState().groupsByWorktree['wt-1'][0].activeTabId).not.toBe('run-1')
  })
})
