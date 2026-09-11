import { describe, expect, it } from 'vitest'
import { buildMobileSessionTabSnapshots } from '../sync-runtime-graph'
import { makeState } from '../sync-runtime-graph-test-harness'
import { getDefaultSettings } from '../../../../shared/constants'
import type { AppState } from '../../store/types'

describe('buildMobileSessionTabSnapshots terminal dock', () => {
  it('publishes terminal dock state to mobile snapshots only when the experimental flag is enabled', () => {
    const leafId = '11111111-1111-4111-8111-111111111111'
    const paneKey = `term-1:${leafId}`
    const dockRecord = { [paneKey]: { docked: true, gutterRows: 8 } }
    const base = makeState({
      settings: { ...getDefaultSettings('/tmp'), experimentalTerminalDock: false },
      activeGroupIdByWorktree: { 'wt-1': 'group-1' },
      groupsByWorktree: {
        'wt-1': [
          {
            id: 'group-1',
            worktreeId: 'wt-1',
            activeTabId: 'term-1',
            tabOrder: ['term-1'],
            recentTabIds: ['term-1']
          }
        ]
      },
      tabsByWorktree: {
        'wt-1': [{ id: 'term-1', title: 'zsh', customTitle: null, ptyId: 'pty-1' }]
      } as unknown as AppState['tabsByWorktree'],
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'term-1',
            entityId: 'term-1',
            groupId: 'group-1',
            worktreeId: 'wt-1',
            contentType: 'terminal',
            label: 'zsh',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            isPreview: false,
            isPinned: false,
            terminalDockByPaneKey: dockRecord
          }
        ]
      } as unknown as AppState['unifiedTabsByWorktree'],
      terminalLayoutsByTabId: {
        'term-1': {
          root: { type: 'leaf', leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: 'pty-1' }
        }
      } as AppState['terminalLayoutsByTabId']
    })

    expect(buildMobileSessionTabSnapshots(base)[0]?.tabs[0]).not.toHaveProperty(
      'terminalDockByPaneKey'
    )
    expect(
      buildMobileSessionTabSnapshots({
        ...base,
        settings: { ...getDefaultSettings('/tmp'), experimentalTerminalDock: true }
      })[0]?.tabs[0]
    ).toMatchObject({
      type: 'terminal',
      terminalDockByPaneKey: dockRecord
    })
  })
})
