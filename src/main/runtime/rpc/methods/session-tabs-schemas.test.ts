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
  OrcaRuntimeService,
  removeTerminalDockPaneKeys
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

describe('SetTabProps.terminalDock.remove (session.tabs.setTabProps params)', () => {
  const OTHER_PANE_KEY = makePaneKey(DOCK_TAB_ID, '22222222-2222-4222-a222-222222222222')

  it('accepts a removal-only patch with no paneKey', () => {
    const parsed = SetTabProps.parse({
      worktree: WT,
      tabId: 'tab-1',
      terminalDock: { remove: [DOCK_PANE_KEY, OTHER_PANE_KEY] }
    })
    expect(parsed.terminalDock).toEqual({ remove: [DOCK_PANE_KEY, OTHER_PANE_KEY] })
  })

  it('accepts a patch carrying both a set and a removal', () => {
    const parsed = SetTabProps.parse({
      worktree: WT,
      tabId: 'tab-1',
      terminalDock: { paneKey: DOCK_PANE_KEY, docked: true, remove: [OTHER_PANE_KEY] }
    })
    expect(parsed.terminalDock).toEqual({
      paneKey: DOCK_PANE_KEY,
      docked: true,
      remove: [OTHER_PANE_KEY]
    })
  })

  it('still rejects docked/gutterRows without paneKey when remove is also present', () => {
    expect(() =>
      SetTabProps.parse({
        worktree: WT,
        tabId: 'tab-1',
        terminalDock: { docked: true, remove: [OTHER_PANE_KEY] }
      })
    ).toThrow()
  })

  it('rejects an invalid pane key inside the removal list', () => {
    expect(() =>
      SetTabProps.parse({
        worktree: WT,
        tabId: 'tab-1',
        terminalDock: { remove: ['not-a-pane-key'] }
      })
    ).toThrow()
  })

  it('rejects a removal list past the cap', () => {
    const remove = Array.from({ length: 65 }, (_, i) => `tab-1:${i}`)
    expect(() =>
      SetTabProps.parse({ worktree: WT, tabId: 'tab-1', terminalDock: { remove } })
    ).toThrow()
  })

  it('accepts a removal list at the cap', () => {
    const remove = Array.from({ length: 64 }, (_, i) => `tab-1:${i}`)
    const parsed = SetTabProps.parse({ worktree: WT, tabId: 'tab-1', terminalDock: { remove } })
    expect(parsed.terminalDock?.remove).toHaveLength(64)
  })

  it('leaves terminalDock unaffected when the patch carries neither paneKey nor remove', () => {
    // Absence must stay a pure leave-unchanged signal — an accidental
    // absence-clears reading would silently wipe other clients' state.
    const parsed = SetTabProps.parse({ worktree: WT, tabId: 'tab-1', color: '#fff' })
    expect(parsed.terminalDock).toBeUndefined()
  })
})

describe('removeTerminalDockPaneKeys (host removal semantics)', () => {
  it('drops only the named keys', () => {
    const existing = {
      'pane-1': { docked: true, gutterRows: 6 },
      'pane-2': { docked: false, gutterRows: 10 }
    }
    expect(removeTerminalDockPaneKeys(existing, ['pane-1'])).toEqual({
      'pane-2': { docked: false, gutterRows: 10 }
    })
  })

  it('is a no-op, not an error, when the key is not present', () => {
    const existing = { 'pane-1': { docked: true, gutterRows: 6 } }
    expect(removeTerminalDockPaneKeys(existing, ['pane-missing'])).toBe(existing)
  })

  it('is a no-op for an undefined record', () => {
    expect(removeTerminalDockPaneKeys(undefined, ['pane-1'])).toBeUndefined()
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

describe('mergeTerminalDockByPaneKey eviction protects live panes (M2: unverified pane-key flood)', () => {
  it('evicts unverified keys before a verified one, even though the verified key was inserted first', () => {
    const livePaneKeys = new Set(['pane-live'])
    let record: Record<string, { docked: boolean; gutterRows: number }> | undefined
    record = mergeTerminalDockByPaneKey(record, { paneKey: 'pane-live', docked: true }, livePaneKeys)
    for (let i = 0; i < MAX_TERMINAL_DOCK_PANE_ENTRIES - 1; i++) {
      record = mergeTerminalDockByPaneKey(
        record,
        { paneKey: `pane-fake-${i}`, docked: true },
        livePaneKeys
      )
    }
    expect(Object.keys(record!)).toHaveLength(MAX_TERMINAL_DOCK_PANE_ENTRIES)

    const flooded = mergeTerminalDockByPaneKey(
      record,
      { paneKey: 'pane-fake-new', docked: true },
      livePaneKeys
    )

    expect(Object.keys(flooded)).toHaveLength(MAX_TERMINAL_DOCK_PANE_ENTRIES)
    expect(flooded['pane-live']).toBeDefined()
    expect(flooded['pane-fake-0']).toBeUndefined()
  })

  it('falls back to oldest-first eviction among verified keys once no unverified key remains', () => {
    const livePaneKeys = new Set(['pane-0', 'pane-1'])
    let record: Record<string, { docked: boolean; gutterRows: number }> | undefined = {
      'pane-0': { docked: true, gutterRows: 5 },
      'pane-1': { docked: true, gutterRows: 5 }
    }
    for (let i = 2; i < MAX_TERMINAL_DOCK_PANE_ENTRIES; i++) {
      livePaneKeys.add(`pane-${i}`)
      record = mergeTerminalDockByPaneKey(record, { paneKey: `pane-${i}`, docked: true }, livePaneKeys)
    }

    livePaneKeys.add('pane-new')
    const grown = mergeTerminalDockByPaneKey(record, { paneKey: 'pane-new', docked: true }, livePaneKeys)

    expect(Object.keys(grown)).toHaveLength(MAX_TERMINAL_DOCK_PANE_ENTRIES)
    expect(grown['pane-0']).toBeUndefined()
    expect(grown['pane-new']).toBeDefined()
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

  it('removes the named key, persists, and republishes, leaving other panes untouched', async () => {
    const otherPaneKey = makePaneKey(DOCK_TAB_ID, '22222222-2222-4222-a222-222222222222')
    const runtime = new OrcaRuntimeService({
      getWorkspaceSession: () => makePersistedSession()
    } as never)

    await runtime.listMobileSessionTabs(`id:${DOCK_WORKTREE_ID}`)
    await runtime.setMobileSessionTabProps(`id:${DOCK_WORKTREE_ID}`, {
      tabId: DOCK_TAB_ID,
      terminalDock: { paneKey: DOCK_PANE_KEY, docked: true, gutterRows: 6 }
    })
    await runtime.setMobileSessionTabProps(`id:${DOCK_WORKTREE_ID}`, {
      tabId: DOCK_TAB_ID,
      terminalDock: { paneKey: otherPaneKey, docked: false, gutterRows: 8 }
    })
    await runtime.setMobileSessionTabProps(`id:${DOCK_WORKTREE_ID}`, {
      tabId: DOCK_TAB_ID,
      terminalDock: { remove: [DOCK_PANE_KEY] }
    })
    const result = await runtime.listMobileSessionTabs(`id:${DOCK_WORKTREE_ID}`)

    expect(result.tabs[0]).toMatchObject({
      terminalDockByPaneKey: { [otherPaneKey]: { docked: false, gutterRows: 8 } }
    })
  })

  it('removing a key that is not present is a no-op, never an error', async () => {
    const runtime = new OrcaRuntimeService({
      getWorkspaceSession: () => makePersistedSession()
    } as never)

    await runtime.listMobileSessionTabs(`id:${DOCK_WORKTREE_ID}`)
    await runtime.setMobileSessionTabProps(`id:${DOCK_WORKTREE_ID}`, {
      tabId: DOCK_TAB_ID,
      terminalDock: { paneKey: DOCK_PANE_KEY, docked: true, gutterRows: 6 }
    })

    await expect(
      runtime.setMobileSessionTabProps(`id:${DOCK_WORKTREE_ID}`, {
        tabId: DOCK_TAB_ID,
        terminalDock: { remove: ['tab:404'] }
      })
    ).resolves.toEqual({ updated: true })

    const result = await runtime.listMobileSessionTabs(`id:${DOCK_WORKTREE_ID}`)
    expect(result.tabs[0]).toMatchObject({
      terminalDockByPaneKey: { [DOCK_PANE_KEY]: { docked: true, gutterRows: 6 } }
    })
  })

  it('a live pane survives churn that previously evicted it, once retired panes are pruned', async () => {
    // Repro (task description): P0 stays docked while P1..P64 are created, docked, and
    // closed one at a time. Before the removal path existed, each churned pane grew the
    // record and the cap eventually evicted P0 by insertion order, not liveness.
    const runtime = new OrcaRuntimeService({
      getWorkspaceSession: () => makePersistedSession()
    } as never)
    await runtime.listMobileSessionTabs(`id:${DOCK_WORKTREE_ID}`)

    await runtime.setMobileSessionTabProps(`id:${DOCK_WORKTREE_ID}`, {
      tabId: DOCK_TAB_ID,
      terminalDock: { paneKey: 'pane-p0', docked: true }
    })

    for (let i = 0; i < MAX_TERMINAL_DOCK_PANE_ENTRIES; i++) {
      const churnKey = `pane-churn-${i}`
      await runtime.setMobileSessionTabProps(`id:${DOCK_WORKTREE_ID}`, {
        tabId: DOCK_TAB_ID,
        terminalDock: { paneKey: churnKey, docked: true }
      })
      await runtime.setMobileSessionTabProps(`id:${DOCK_WORKTREE_ID}`, {
        tabId: DOCK_TAB_ID,
        terminalDock: { remove: [churnKey] }
      })
    }

    const result = await runtime.listMobileSessionTabs(`id:${DOCK_WORKTREE_ID}`)
    expect(result.tabs[0]).toMatchObject({
      terminalDockByPaneKey: {
        'pane-p0': { docked: true, gutterRows: DEFAULT_TERMINAL_DOCK_GUTTER_ROWS }
      }
    })
  })

  it('a flood of fabricated pane keys cannot evict a host-verified live pane, and legitimate updates for known panes still persist (M2)', async () => {
    const runtime = new OrcaRuntimeService({
      getWorkspaceSession: () => makePersistedSession()
    } as never)
    // Why: registerPty is the host's own PTY-binding record, independent of any
    // client-supplied dock patch — it's the "known live pane" source under test.
    runtime.registerPty('pty-live', DOCK_WORKTREE_ID, null, {
      tabId: DOCK_TAB_ID,
      leafId: '11111111-1111-4111-a111-111111111111'
    })
    await runtime.listMobileSessionTabs(`id:${DOCK_WORKTREE_ID}`)
    await runtime.setMobileSessionTabProps(`id:${DOCK_WORKTREE_ID}`, {
      tabId: DOCK_TAB_ID,
      terminalDock: { paneKey: DOCK_PANE_KEY, docked: true, gutterRows: 6 }
    })

    const fakeLeafId = (i: number): string => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`
    for (let i = 0; i < MAX_TERMINAL_DOCK_PANE_ENTRIES; i++) {
      await runtime.setMobileSessionTabProps(`id:${DOCK_WORKTREE_ID}`, {
        tabId: DOCK_TAB_ID,
        terminalDock: { paneKey: makePaneKey(DOCK_TAB_ID, fakeLeafId(i)), docked: true }
      })
    }

    const flooded = await runtime.listMobileSessionTabs(`id:${DOCK_WORKTREE_ID}`)
    expect(flooded.tabs[0]).toMatchObject({
      terminalDockByPaneKey: expect.objectContaining({
        [DOCK_PANE_KEY]: { docked: true, gutterRows: 6 }
      })
    })

    await runtime.setMobileSessionTabProps(`id:${DOCK_WORKTREE_ID}`, {
      tabId: DOCK_TAB_ID,
      terminalDock: { paneKey: DOCK_PANE_KEY, gutterRows: 9 }
    })
    const updated = await runtime.listMobileSessionTabs(`id:${DOCK_WORKTREE_ID}`)
    expect(updated.tabs[0]).toMatchObject({
      terminalDockByPaneKey: expect.objectContaining({
        [DOCK_PANE_KEY]: { docked: true, gutterRows: 9 }
      })
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
