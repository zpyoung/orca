import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../../shared/types'
import { resolveTerminalDockPruneTarget } from './terminal-pane-dock-prune'

function makeUnifiedTab(overrides: Partial<Tab>): Tab {
  return {
    id: 'unified-1',
    entityId: 'terminal-1',
    groupId: 'group-1',
    worktreeId: 'wt-1',
    contentType: 'terminal',
    label: 'Terminal',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  } as Tab
}

describe('resolveTerminalDockPruneTarget', () => {
  it('resolves the unified tab id and the closed pane key for a retiring pane', () => {
    const unifiedTab = makeUnifiedTab({ entityId: 'terminal-1' })
    const result = resolveTerminalDockPruneTarget({
      unifiedTabsByWorktree: { 'wt-1': [unifiedTab] },
      worktreeId: 'wt-1',
      tabId: 'terminal-1',
      leafId: '11111111-1111-4111-8111-111111111111',
      experimentalTerminalDockEnabled: true
    })
    expect(result).toEqual({
      unifiedTabId: 'unified-1',
      paneKey: 'terminal-1:11111111-1111-4111-8111-111111111111'
    })
  })

  it('returns null when the source tab has no corresponding unified tab', () => {
    const result = resolveTerminalDockPruneTarget({
      unifiedTabsByWorktree: { 'wt-1': [] },
      worktreeId: 'wt-1',
      tabId: 'terminal-1',
      leafId: '11111111-1111-4111-8111-111111111111',
      experimentalTerminalDockEnabled: true
    })
    expect(result).toBeNull()
  })

  it('returns null when the flag is off, even for a pane with a real unified tab', () => {
    const unifiedTab = makeUnifiedTab({ entityId: 'terminal-1' })
    const result = resolveTerminalDockPruneTarget({
      unifiedTabsByWorktree: { 'wt-1': [unifiedTab] },
      worktreeId: 'wt-1',
      tabId: 'terminal-1',
      leafId: '11111111-1111-4111-8111-111111111111',
      experimentalTerminalDockEnabled: false
    })
    expect(result).toBeNull()
  })
})
