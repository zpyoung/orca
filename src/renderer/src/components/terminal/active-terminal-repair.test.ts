import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../../shared/types'
import { useAppStore } from '@/store'
import {
  resolveRepairedActiveTerminalTabId,
  shouldRepairActiveTerminalTab
} from './active-terminal-repair'

function tab(id: string, worktreeId = 'wt-1'): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

const initialAppState = useAppStore.getInitialState()

// seeds the store so `worktreeId`'s focused group's active tab is a pipeline canvas —
// the state active-terminal-repair reads to decide whether a null activeTabId is an
// intentional pipeline focus rather than something stale to repair.
function seedPipelineTabActive(worktreeId: string): void {
  useAppStore.setState(
    {
      ...initialAppState,
      activeGroupIdByWorktree: { [worktreeId]: 'group-1' },
      groupsByWorktree: {
        [worktreeId]: [{ id: 'group-1', worktreeId, activeTabId: 'pipe-tab-1', tabOrder: ['pipe-tab-1'] }]
      },
      unifiedTabsByWorktree: {
        [worktreeId]: [
          {
            id: 'pipe-tab-1',
            entityId: 'run-1',
            groupId: 'group-1',
            worktreeId,
            contentType: 'pipeline',
            label: 'bugfix-fast #1',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      }
    },
    true
  )
}

describe('shouldRepairActiveTerminalTab', () => {
  afterEach(() => {
    useAppStore.setState(initialAppState, true)
  })

  it('does not repair while editor or browser content is active', () => {
    expect(
      shouldRepairActiveTerminalTab({
        activeTabType: 'editor',
        activeTabId: 'missing',
        tabs: [tab('cli-terminal')]
      })
    ).toBe(false)
    expect(
      shouldRepairActiveTerminalTab({
        activeTabType: 'browser',
        activeTabId: null,
        tabs: [tab('cli-terminal')]
      })
    ).toBe(false)
  })

  it('repairs stale terminal active ids only while terminal content is active', () => {
    expect(
      shouldRepairActiveTerminalTab({
        activeTabType: 'terminal',
        activeTabId: 'missing',
        tabs: [tab('terminal-1')]
      })
    ).toBe(true)
    expect(
      shouldRepairActiveTerminalTab({
        activeTabType: 'terminal',
        activeTabId: 'terminal-1',
        tabs: [tab('terminal-1')]
      })
    ).toBe(false)
  })
})

describe('shouldRepairActiveTerminalTab with a pipeline tab active', () => {
  beforeEach(() => {
    seedPipelineTabActive('wt-1')
  })

  afterEach(() => {
    useAppStore.setState(initialAppState, true)
  })

  it('does not resurrect a terminal id for a workspace whose active tab is a pipeline canvas', () => {
    expect(
      shouldRepairActiveTerminalTab({
        activeTabType: 'terminal',
        activeTabId: null,
        tabs: [tab('terminal-1', 'wt-1')]
      })
    ).toBe(false)
  })

  it('still repairs a different, genuinely terminal-active workspace', () => {
    expect(
      shouldRepairActiveTerminalTab({
        activeTabType: 'terminal',
        activeTabId: null,
        tabs: [tab('terminal-1', 'wt-other')]
      })
    ).toBe(true)
  })
})

describe('resolveRepairedActiveTerminalTabId', () => {
  it('returns null when no repair is needed', () => {
    expect(
      resolveRepairedActiveTerminalTabId({
        activeTabType: 'terminal',
        activeTabId: 'terminal-2',
        rememberedTabId: 'terminal-1',
        tabs: [tab('terminal-1'), tab('terminal-2')]
      })
    ).toBeNull()
  })

  it('restores the remembered tab instead of the first tab when repairing', () => {
    // Why (regression): a repair firing on a transient worktree-switch render
    // must not reset the selection to Terminal 1 — it should land on the tab
    // the worktree remembers the user was on.
    expect(
      resolveRepairedActiveTerminalTabId({
        activeTabType: 'terminal',
        activeTabId: 'stale-from-other-worktree',
        rememberedTabId: 'terminal-2',
        tabs: [tab('terminal-1'), tab('terminal-2')]
      })
    ).toBe('terminal-2')
  })

  it('falls back to the first tab when the remembered tab is missing or stale', () => {
    expect(
      resolveRepairedActiveTerminalTabId({
        activeTabType: 'terminal',
        activeTabId: 'missing',
        rememberedTabId: null,
        tabs: [tab('terminal-1'), tab('terminal-2')]
      })
    ).toBe('terminal-1')
    expect(
      resolveRepairedActiveTerminalTabId({
        activeTabType: 'terminal',
        activeTabId: 'missing',
        rememberedTabId: 'no-longer-open',
        tabs: [tab('terminal-1'), tab('terminal-2')]
      })
    ).toBe('terminal-1')
  })

  it('leaves a pipeline-active workspace alone instead of resolving a terminal to switch to', () => {
    seedPipelineTabActive('wt-1')
    try {
      expect(
        resolveRepairedActiveTerminalTabId({
          activeTabType: 'terminal',
          activeTabId: null,
          rememberedTabId: null,
          tabs: [tab('terminal-1', 'wt-1')]
        })
      ).toBeNull()
    } finally {
      useAppStore.setState(initialAppState, true)
    }
  })
})
