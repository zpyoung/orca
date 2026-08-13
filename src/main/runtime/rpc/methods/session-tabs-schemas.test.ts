import { describe, expect, it } from 'vitest'
import {
  ActivateTab,
  CloseLifecycleTab,
  CloseTab,
  SetTabProps,
  UpdatePaneLayout
} from './session-tabs-schemas'
import {
  DEFAULT_TERMINAL_DOCK_GUTTER_ROWS,
  MAX_TERMINAL_DOCK_PANE_ENTRIES,
  mergeTerminalDockByPaneKey,
  OrcaRuntimeService
} from '../../orca-runtime'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import type { Tab, TerminalTab, WorkspaceSessionState } from '../../../../shared/types'
import { makePaneKey } from '../../../../shared/stable-pane-id'

const WT = 'id:wt'
const DOCK_WORKTREE_ID = 'repo::/worktree'
const DOCK_TAB_ID = 'tab'
const DOCK_PANE_KEY = makePaneKey(DOCK_TAB_ID, '11111111-1111-4111-a111-111111111111')

describe('ActivateTab.navigation', () => {
  it('accepts declared targets and rejects unknown fanout', () => {
    expect(ActivateTab.parse({ worktree: WT, tabId: 'tab', navigation: 'all' }).navigation).toBe(
      'all'
    )
    expect(
      ActivateTab.safeParse({ worktree: WT, tabId: 'tab', navigation: 'others' }).success
    ).toBe(false)
  })
})

describe('CloseTab (session.tabs.close params)', () => {
  it('accepts only explicit user intent on the legacy close method', () => {
    const parsed = CloseTab.parse({ worktree: WT, tabId: 'tab-1', reason: 'user' })
    expect(parsed).toMatchObject({ tabId: 'tab-1', reason: 'user' })
    expect(CloseTab.safeParse({ worktree: WT, tabId: 'tab-1', reason: 'pty-exit' }).success).toBe(
      false
    )
    expect(CloseTab.safeParse({ worktree: WT, tabId: 'tab-1', reason: 'cleanup' }).success).toBe(
      false
    )
  })

  it('accepts a reasonless payload from legacy clients', () => {
    // Why: parsing remains compatible; the RPC policy, not the schema, refuses missing intent.
    const parsed = CloseTab.parse({ worktree: WT, tabId: 'tab-1' })
    expect(parsed.tabId).toBe('tab-1')
    expect(parsed.reason).toBeUndefined()
  })

  it('keeps a new explicit-user payload parseable by the previous server schema', () => {
    // Why: old hosts use ActivateTab here and must strip the additive field,
    // not reject a manual close from an updated client.
    const parsed = ActivateTab.parse({ worktree: WT, tabId: 'tab-1', reason: 'user' })
    expect(parsed).toEqual({ worktree: WT, tabId: 'tab-1' })
  })

  it('rejects an unknown close reason', () => {
    expect(() =>
      CloseTab.parse({ worktree: WT, tabId: 'tab-1', reason: 'transport-glitch' })
    ).toThrow()
  })
})

describe('CloseLifecycleTab (session.tabs.closeLifecycle params)', () => {
  it('requires lifecycle intent and incarnation evidence', () => {
    expect(
      CloseLifecycleTab.parse({
        worktree: WT,
        tabId: 'tab-1',
        reason: 'pty-exit',
        publicationEpoch: 'epoch-1',
        terminal: 'term-1'
      })
    ).toMatchObject({ reason: 'pty-exit', publicationEpoch: 'epoch-1', terminal: 'term-1' })
    expect(
      CloseLifecycleTab.safeParse({ worktree: WT, tabId: 'tab-1', reason: 'pty-exit' }).success
    ).toBe(false)
    expect(
      CloseLifecycleTab.safeParse({
        worktree: WT,
        tabId: 'tab-1',
        reason: 'user',
        publicationEpoch: 'epoch-1',
        terminal: 'term-1'
      }).success
    ).toBe(false)
  })
})

describe('UpdatePaneLayout.root (untrusted remote pane-layout tree)', () => {
  it('accepts a valid split tree', () => {
    const parsed = UpdatePaneLayout.parse({
      worktree: WT,
      tabId: 'tab',
      root: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: 'a' },
        second: { type: 'leaf', leafId: 'b' },
        ratio: 0.5
      }
    })
    expect(parsed.root).toMatchObject({ type: 'split', direction: 'horizontal' })
  })

  it('accepts a null root', () => {
    expect(UpdatePaneLayout.parse({ worktree: WT, tabId: 'tab', root: null }).root).toBeNull()
  })

  it('rejects an over-deep tree instead of overflowing the stack', () => {
    // Build a tree deeper than the cap (64) without recursion in the test.
    let node: unknown = { type: 'leaf', leafId: 'x' }
    for (let i = 0; i < 5000; i++) {
      node = {
        type: 'split',
        direction: 'vertical',
        first: node,
        second: { type: 'leaf', leafId: 'y' }
      }
    }
    expect(() => UpdatePaneLayout.parse({ worktree: WT, tabId: 'tab', root: node })).toThrow()
  })

  it('rejects a leaf with an invalid leafId', () => {
    expect(() =>
      UpdatePaneLayout.parse({ worktree: WT, tabId: 'tab', root: { type: 'leaf', leafId: '' } })
    ).toThrow()
  })

  it('rejects an unknown node type', () => {
    expect(() =>
      UpdatePaneLayout.parse({ worktree: WT, tabId: 'tab', root: { type: 'bogus' } })
    ).toThrow()
  })

  it('rejects a ratio outside 0..1', () => {
    expect(() =>
      UpdatePaneLayout.parse({
        worktree: WT,
        tabId: 'tab',
        root: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', leafId: 'a' },
          second: { type: 'leaf', leafId: 'b' },
          ratio: 5
        }
      })
    ).toThrow()
  })
})

describe('SetTabProps.terminalDock (session.tabs.setTabProps params)', () => {
  it('parses a single-pane dock patch', () => {
    const parsed = SetTabProps.parse({
      worktree: WT,
      tabId: 'tab-1',
      terminalDock: { paneKey: 'tab-1:1', docked: true, gutterRows: 6 }
    })
    expect(parsed.terminalDock).toEqual({ paneKey: 'tab-1:1', docked: true, gutterRows: 6 })
  })

  it('accepts a patch with only one of docked/gutterRows set', () => {
    const parsed = SetTabProps.parse({
      worktree: WT,
      tabId: 'tab-1',
      terminalDock: { paneKey: 'tab-1:1', docked: true }
    })
    expect(parsed.terminalDock).toEqual({ paneKey: 'tab-1:1', docked: true })
  })

  it('leaves other props unchanged when terminalDock is absent', () => {
    const parsed = SetTabProps.parse({
      worktree: WT,
      tabId: 'tab-1',
      color: '#fff'
    })
    expect(parsed.terminalDock).toBeUndefined()
    expect(parsed.color).toBe('#fff')
  })

  it('rejects a gutterRows value outside 3..15', () => {
    expect(() =>
      SetTabProps.parse({
        worktree: WT,
        tabId: 'tab-1',
        terminalDock: { paneKey: 'tab-1:1', gutterRows: 999 }
      })
    ).toThrow()
  })

  it('rejects a missing paneKey', () => {
    expect(() =>
      SetTabProps.parse({
        worktree: WT,
        tabId: 'tab-1',
        terminalDock: { docked: true }
      })
    ).toThrow()
  })

  // D4: paneKey is attacker-reachable input, so its shape is bound to the two
  // formats the host ever mints (makePaneKey's tabId:UUID, or the legacy
  // tabId:N numeric pane) instead of accepting an arbitrary string.
  it('accepts a paneKey minted by makePaneKey', () => {
    const parsed = SetTabProps.parse({
      worktree: WT,
      tabId: 'tab-1',
      terminalDock: { paneKey: DOCK_PANE_KEY, docked: true }
    })
    expect(parsed.terminalDock?.paneKey).toBe(DOCK_PANE_KEY)
  })

  it('accepts a legacy numeric pane key', () => {
    const parsed = SetTabProps.parse({
      worktree: WT,
      tabId: 'tab-1',
      terminalDock: { paneKey: 'tab-1:3', docked: true }
    })
    expect(parsed.terminalDock?.paneKey).toBe('tab-1:3')
  })

  it('rejects a pane key matching neither the stable nor the legacy numeric format', () => {
    expect(() =>
      SetTabProps.parse({
        worktree: WT,
        tabId: 'tab-1',
        terminalDock: { paneKey: 'not-a-pane-key', docked: true }
      })
    ).toThrow()
  })

  it('rejects an overlong pane key', () => {
    expect(() =>
      SetTabProps.parse({
        worktree: WT,
        tabId: 'tab-1',
        terminalDock: { paneKey: `tab-1:${'1'.repeat(300)}`, docked: true }
      })
    ).toThrow()
  })
})

describe('mergeTerminalDockByPaneKey (host merge semantics)', () => {
  it('merges into an existing multi-pane record and defaults a fresh entry', () => {
    const existing = {
      'pane-1': { docked: true, gutterRows: 6 },
      'pane-2': { docked: false, gutterRows: 10 }
    }
    expect(mergeTerminalDockByPaneKey(existing, { paneKey: 'pane-2', docked: true })).toEqual({
      'pane-1': { docked: true, gutterRows: 6 },
      'pane-2': { docked: true, gutterRows: 10 }
    })
    expect(mergeTerminalDockByPaneKey(undefined, { paneKey: 'pane-3', docked: true })).toEqual({
      'pane-3': { docked: true, gutterRows: DEFAULT_TERMINAL_DOCK_GUTTER_ROWS }
    })
  })
})

describe('mergeTerminalDockByPaneKey entry cap (D4: unbounded attacker-supplied pane keys)', () => {
  it('evicts the oldest entry once the cap is exceeded, and keeps the entry just written', () => {
    let record: Record<string, { docked: boolean; gutterRows: number }> | undefined
    for (let i = 0; i < MAX_TERMINAL_DOCK_PANE_ENTRIES; i++) {
      record = mergeTerminalDockByPaneKey(record, { paneKey: `pane-${i}`, docked: true })
    }
    expect(Object.keys(record!)).toHaveLength(MAX_TERMINAL_DOCK_PANE_ENTRIES)

    const grown = mergeTerminalDockByPaneKey(record, { paneKey: 'pane-new', docked: true })

    expect(Object.keys(grown)).toHaveLength(MAX_TERMINAL_DOCK_PANE_ENTRIES)
    expect(grown['pane-new']).toEqual({
      docked: true,
      gutterRows: DEFAULT_TERMINAL_DOCK_GUTTER_ROWS
    })
    expect(grown['pane-0']).toBeUndefined()
    expect(grown['pane-1']).toBeDefined()
  })

  it('updating an existing entry at the cap evicts nothing', () => {
    let record: Record<string, { docked: boolean; gutterRows: number }> | undefined
    for (let i = 0; i < MAX_TERMINAL_DOCK_PANE_ENTRIES; i++) {
      record = mergeTerminalDockByPaneKey(record, { paneKey: `pane-${i}`, docked: false })
    }

    const updated = mergeTerminalDockByPaneKey(record, { paneKey: 'pane-0', docked: true })

    expect(Object.keys(updated)).toHaveLength(MAX_TERMINAL_DOCK_PANE_ENTRIES)
    expect(updated['pane-0']).toEqual({
      docked: true,
      gutterRows: DEFAULT_TERMINAL_DOCK_GUTTER_ROWS
    })
  })
})

describe('terminalDockByPaneKey publication (D3: write-only field)', () => {
  function makePersistedSession(
    overrides: Partial<WorkspaceSessionState> = {}
  ): WorkspaceSessionState {
    const terminalTab: TerminalTab = {
      id: DOCK_TAB_ID,
      ptyId: 'pty-1',
      worktreeId: DOCK_WORKTREE_ID,
      title: 'Terminal',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
    return {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [DOCK_WORKTREE_ID]: [terminalTab] },
      ...overrides
    }
  }

  it('echoes a terminalDock patch back on the published mobile session snapshot', async () => {
    const runtime = new OrcaRuntimeService({
      getWorkspaceSession: () => makePersistedSession()
    } as never)

    await runtime.listMobileSessionTabs(`id:${DOCK_WORKTREE_ID}`)
    await runtime.setMobileSessionTabProps(`id:${DOCK_WORKTREE_ID}`, {
      tabId: DOCK_TAB_ID,
      terminalDock: { paneKey: DOCK_PANE_KEY, docked: true, gutterRows: 6 }
    })
    const result = await runtime.listMobileSessionTabs(`id:${DOCK_WORKTREE_ID}`)

    expect(result.tabs[0]).toMatchObject({
      terminalDockByPaneKey: { [DOCK_PANE_KEY]: { docked: true, gutterRows: 6 } }
    })
  })

  it('rehydrates a persisted dock record from the unified tab on restart', async () => {
    const unifiedTab: Tab = {
      id: DOCK_TAB_ID,
      entityId: DOCK_TAB_ID,
      groupId: 'group-1',
      worktreeId: DOCK_WORKTREE_ID,
      contentType: 'terminal',
      label: 'Terminal',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 1,
      terminalDockByPaneKey: { [DOCK_PANE_KEY]: { docked: true, gutterRows: 6 } }
    }
    const runtime = new OrcaRuntimeService({
      getWorkspaceSession: () =>
        makePersistedSession({ unifiedTabs: { [DOCK_WORKTREE_ID]: [unifiedTab] } })
    } as never)

    const result = await runtime.listMobileSessionTabs(`id:${DOCK_WORKTREE_ID}`)

    expect(result.tabs[0]).toMatchObject({
      terminalDockByPaneKey: { [DOCK_PANE_KEY]: { docked: true, gutterRows: 6 } }
    })
  })
})
