import { describe, expect, it } from 'vitest'
import { buildMobileSessionTabSnapshots } from './sync-runtime-graph'
import type { AppState } from '../store/types'

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    tabsByWorktree: {},
    terminalLayoutsByTabId: {} as AppState['terminalLayoutsByTabId'],
    runtimePaneTitlesByTabId: {} as AppState['runtimePaneTitlesByTabId'],
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    unifiedTabsByWorktree: {},
    tabBarOrderByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    activeTabType: 'terminal',
    activeTabTypeByWorktree: {},
    activeBrowserTabIdByWorktree: {},
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    browserCertificateFailuresByPageId: {},
    openFiles: [],
    editorDrafts: {},
    activeTabId: null,
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    ...overrides
  } as AppState
}

describe('buildMobileSessionTabSnapshots — pipeline tab omission', () => {
  it('omits a focused pipeline tab from tabs, tabOrder, and active fields in a split group', () => {
    const fileId = '/repo/src/app.ts'
    const leafId = '11111111-1111-4111-8111-111111111111'
    const state = makeState({
      activeGroupIdByWorktree: { 'wt-1': 'group-1' },
      groupsByWorktree: {
        'wt-1': [
          {
            id: 'group-1',
            activeTabId: 'pipeline-tab-1',
            tabOrder: ['terminal-tab-1', 'editor-tab-1', 'pipeline-tab-1'],
            recentTabIds: ['pipeline-tab-1']
          }
        ]
      } as unknown as AppState['groupsByWorktree'],
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'terminal-tab-1',
            groupId: 'group-1',
            contentType: 'terminal',
            entityId: 'term-1',
            title: 'Terminal'
          },
          {
            id: 'editor-tab-1',
            groupId: 'group-1',
            contentType: 'editor',
            entityId: fileId,
            title: 'app.ts'
          },
          {
            id: 'pipeline-tab-1',
            groupId: 'group-1',
            contentType: 'pipeline',
            entityId: 'run-1',
            title: 'bugfix-fast #4'
          }
        ]
      } as unknown as AppState['unifiedTabsByWorktree'],
      tabsByWorktree: {
        'wt-1': [
          {
            id: 'term-1',
            worktreeId: 'wt-1',
            ptyId: 'pty-1',
            title: 'Terminal',
            defaultTitle: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      } as unknown as AppState['tabsByWorktree'],
      terminalLayoutsByTabId: {
        'term-1': {
          root: { type: 'leaf', leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: 'pty-1' }
        }
      } as unknown as AppState['terminalLayoutsByTabId'],
      openFiles: [
        {
          id: fileId,
          filePath: fileId,
          relativePath: 'src/app.ts',
          worktreeId: 'wt-1',
          language: 'typescript',
          mode: 'edit',
          isDirty: false
        }
      ]
    })

    const snapshot = buildMobileSessionTabSnapshots(state)[0]

    expect(snapshot?.tabs).toMatchObject([
      { type: 'terminal', id: `term-1::${leafId}` },
      { type: 'file', id: 'editor-tab-1', relativePath: 'src/app.ts' }
    ])
    expect(snapshot?.tabs).toHaveLength(2)
    expect(snapshot?.tabGroups).toEqual([
      {
        id: 'group-1',
        activeTabId: null,
        tabOrder: ['terminal-tab-1', 'editor-tab-1'],
        recentTabIds: []
      }
    ])
    expect(snapshot?.activeTabId).toBeNull()
    expect(snapshot?.activeTabType).toBeNull()
  })

  it('omits a pipeline tab published through the legacy no-group projection order', () => {
    const state = makeState({
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'pipeline-tab-1',
            groupId: 'group-1',
            contentType: 'pipeline',
            entityId: 'run-1',
            title: 'bugfix-fast #4'
          }
        ]
      } as unknown as AppState['unifiedTabsByWorktree']
    })

    const snapshot = buildMobileSessionTabSnapshots(state)[0]

    expect(snapshot?.tabs).toEqual([])
    expect(snapshot?.activeTabId).toBeNull()
    expect(snapshot?.activeTabType).toBeNull()
  })

  it('does not let a pipeline tab leak through the fallback editor-tab recovery sweep', () => {
    const fileId = '/repo/src/app.ts'
    const state = makeState({
      activeGroupIdByWorktree: { 'wt-1': 'group-1' },
      groupsByWorktree: {
        'wt-1': [{ id: 'group-1', activeTabId: null, tabOrder: [], recentTabIds: [] }]
      } as unknown as AppState['groupsByWorktree'],
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'pipeline-tab-1',
            groupId: 'group-1',
            contentType: 'pipeline',
            entityId: 'run-1',
            title: 'bugfix-fast #4'
          },
          {
            id: 'editor-tab-1',
            groupId: 'group-1',
            contentType: 'editor',
            entityId: fileId,
            title: 'app.ts'
          }
        ]
      } as unknown as AppState['unifiedTabsByWorktree'],
      openFiles: [
        {
          id: fileId,
          filePath: fileId,
          relativePath: 'src/app.ts',
          worktreeId: 'wt-1',
          language: 'typescript',
          mode: 'edit',
          isDirty: false
        }
      ]
    })

    const snapshot = buildMobileSessionTabSnapshots(state)[0]

    expect(snapshot?.tabs).toMatchObject([{ type: 'file', id: 'editor-tab-1' }])
    expect(snapshot?.tabs).toHaveLength(1)
    for (const group of snapshot?.tabGroups ?? []) {
      expect(group.tabOrder).not.toContain('pipeline-tab-1')
      expect(group.activeTabId).not.toBe('pipeline-tab-1')
    }
  })
})
