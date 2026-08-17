import { describe, expect, it, vi } from 'vitest'
import type { Tab, TabGroup } from '../../../shared/types'
import type { AppState } from '@/store/types'

const { getStateMock } = vi.hoisted(() => ({ getStateMock: vi.fn() }))

vi.mock('@/store', () => ({
  useAppStore: { getState: getStateMock }
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: vi.fn(() => undefined)
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  activateWebRuntimeSessionTab: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(() => false)
}))

vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: vi.fn()
}))

import { activateTabNumberShortcut, resolveTabNumberShortcutTarget } from './tab-number-shortcuts'

function tab(overrides: Partial<Tab> & Pick<Tab, 'id' | 'groupId'>): Tab {
  return {
    id: overrides.id,
    entityId: overrides.entityId ?? overrides.id,
    groupId: overrides.groupId,
    worktreeId: overrides.worktreeId ?? 'wt-1',
    contentType: overrides.contentType ?? 'terminal',
    label: overrides.label ?? overrides.id,
    customLabel: overrides.customLabel ?? null,
    color: overrides.color ?? null,
    sortOrder: overrides.sortOrder ?? 0,
    createdAt: overrides.createdAt ?? 0,
    isPreview: overrides.isPreview,
    isPinned: overrides.isPinned
  }
}

function state(overrides: {
  activeView?: AppState['activeView']
  activeWorktreeId?: string | null
  activeGroupId?: string
  groups?: TabGroup[]
  tabs?: Tab[]
}): Pick<
  AppState,
  | 'activeGroupIdByWorktree'
  | 'activeView'
  | 'activeWorktreeId'
  | 'groupsByWorktree'
  | 'repos'
  | 'settings'
  | 'unifiedTabsByWorktree'
  | 'worktreesByRepo'
> {
  const worktreeId = overrides.activeWorktreeId ?? 'wt-1'
  return {
    activeView: overrides.activeView ?? 'terminal',
    activeWorktreeId: worktreeId,
    activeGroupIdByWorktree:
      worktreeId === null ? {} : { [worktreeId]: overrides.activeGroupId ?? 'group-a' },
    groupsByWorktree: worktreeId === null ? {} : { [worktreeId]: overrides.groups ?? [] },
    repos:
      worktreeId === null
        ? []
        : ([{ id: 'repo-1', connectionId: null, executionHostId: 'local' }] as never),
    settings: { activeRuntimeEnvironmentId: null } as never,
    worktreesByRepo:
      worktreeId === null ? {} : { 'repo-1': [{ id: worktreeId, repoId: 'repo-1' }] as never },
    unifiedTabsByWorktree: worktreeId === null ? {} : { [worktreeId]: overrides.tabs ?? [] }
  }
}

describe('resolveTabNumberShortcutTarget', () => {
  it('resolves by the active group tab order', () => {
    const first = tab({ id: 'tab-1', groupId: 'group-a' })
    const second = tab({ id: 'tab-2', groupId: 'group-a' })
    const third = tab({ id: 'tab-3', groupId: 'group-a' })

    expect(
      resolveTabNumberShortcutTarget(
        state({
          groups: [
            {
              id: 'group-a',
              worktreeId: 'wt-1',
              activeTabId: null,
              tabOrder: ['tab-2', 'tab-3', 'tab-1']
            }
          ],
          tabs: [first, second, third]
        }),
        1
      )
    ).toBe(third)
  })

  it('ignores stale duplicate ids and appends current group tabs missing from tabOrder', () => {
    const first = tab({ id: 'tab-1', groupId: 'group-a' })
    const second = tab({ id: 'tab-2', groupId: 'group-a' })

    expect(
      resolveTabNumberShortcutTarget(
        state({
          groups: [
            {
              id: 'group-a',
              worktreeId: 'wt-1',
              activeTabId: null,
              tabOrder: ['stale', 'tab-1', 'tab-1']
            }
          ],
          tabs: [first, second]
        }),
        1
      )
    ).toBe(second)
  })

  it('uses only the active split group', () => {
    const otherGroupTab = tab({ id: 'tab-other', groupId: 'group-a' })
    const activeGroupTab = tab({ id: 'tab-active', groupId: 'group-b' })

    expect(
      resolveTabNumberShortcutTarget(
        state({
          activeGroupId: 'group-b',
          groups: [
            { id: 'group-a', worktreeId: 'wt-1', activeTabId: null, tabOrder: ['tab-other'] },
            { id: 'group-b', worktreeId: 'wt-1', activeTabId: null, tabOrder: ['tab-active'] }
          ],
          tabs: [otherGroupTab, activeGroupTab]
        }),
        0
      )
    ).toBe(activeGroupTab)
  })

  it('returns null outside terminal workspaces or out of range', () => {
    const only = tab({ id: 'tab-1', groupId: 'group-a' })
    const base = state({
      groups: [{ id: 'group-a', worktreeId: 'wt-1', activeTabId: null, tabOrder: ['tab-1'] }],
      tabs: [only]
    })

    expect(resolveTabNumberShortcutTarget(base, 2)).toBeNull()
    expect(resolveTabNumberShortcutTarget({ ...base, activeView: 'settings' }, 0)).toBeNull()
    expect(resolveTabNumberShortcutTarget({ ...base, activeWorktreeId: null }, 0)).toBeNull()
    expect(resolveTabNumberShortcutTarget(base, -1)).toBeNull()
  })
})

describe('activateTabNumberShortcut', () => {
  it('activates a pipeline tab without writing its run id into setActiveFile', () => {
    const pipelineTab = tab({
      id: 'tab-p1',
      groupId: 'group-a',
      entityId: 'run_abc',
      contentType: 'pipeline'
    })
    const setActiveFile = vi.fn()
    const setActiveTabType = vi.fn()
    const activateTab = vi.fn()
    const focusGroup = vi.fn()
    getStateMock.mockReturnValue({
      ...state({
        groups: [{ id: 'group-a', worktreeId: 'wt-1', activeTabId: null, tabOrder: ['tab-p1'] }],
        tabs: [pipelineTab]
      }),
      setActiveFile,
      setActiveTabType,
      activateTab,
      focusGroup,
      setActiveTab: vi.fn(),
      setActiveBrowserTab: vi.fn(),
      activatePipelineTabSurface: vi.fn()
    })

    expect(activateTabNumberShortcut(0)).toBe(true)
    expect(activateTab).toHaveBeenCalledWith('tab-p1')
    expect(setActiveFile).not.toHaveBeenCalled()
    expect(setActiveTabType).not.toHaveBeenCalledWith('editor')
  })

  it('clears a previously active terminal id when a pipeline tab is switched to by number', () => {
    const pipelineTab = tab({
      id: 'tab-p1',
      groupId: 'group-a',
      entityId: 'run_abc',
      contentType: 'pipeline'
    })
    const activatePipelineTabSurface = vi.fn()
    getStateMock.mockReturnValue({
      ...state({
        groups: [{ id: 'group-a', worktreeId: 'wt-1', activeTabId: null, tabOrder: ['tab-p1'] }],
        tabs: [pipelineTab]
      }),
      setActiveFile: vi.fn(),
      setActiveTabType: vi.fn(),
      activateTab: vi.fn(),
      focusGroup: vi.fn(),
      setActiveTab: vi.fn(),
      setActiveBrowserTab: vi.fn(),
      activatePipelineTabSurface
    })

    expect(activateTabNumberShortcut(0)).toBe(true)
    expect(activatePipelineTabSurface).toHaveBeenCalledWith('wt-1')
  })
})
