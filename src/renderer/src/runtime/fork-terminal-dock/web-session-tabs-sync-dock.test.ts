/* eslint-disable max-lines -- Why: these tests cover one reconciliation boundary
 * across ready, pending, split, and batched session snapshots. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'

import type { GlobalSettings, Tab, TerminalTab } from '../../../../shared/types'

import { recordWebAgentSessionHandoff } from '../web-agent-session-handoff'

import { applyWebSessionTabsSnapshot, type WebSessionTabsSyncState } from '../web-session-tabs-sync'

vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn()
  }
}))

const WT = 'repo::/worktree'
const ENV = 'web-env-1'
const NOW = 1_700_000_000_000
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const HOST_SURFACE_ID = `host-tab-1::${LEAF_ID}`

function makeState(overrides: Partial<WebSessionTabsSyncState> = {}): WebSessionTabsSyncState {
  return {
    activeBrowserTabId: null,
    activeBrowserTabIdByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    activeGroupIdByWorktree: {},
    activeTabId: null,
    activeTabIdByWorktree: {},
    activeTabType: 'terminal',
    activeTabTypeByWorktree: {},
    activeWorktreeId: WT,
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    browserCertificateFailuresByPageId: {},
    browserPagesByWorkspace: {},
    browserTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    openFiles: [],
    ptyIdsByTabId: {},
    remoteBrowserPageHandlesByPageId: {},
    // Why: every fixture here exercises dock reconciliation, which requires the setting on.
    settings: { experimentalTerminalDock: true } as GlobalSettings,
    tabBarOrderByWorktree: {},
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    unifiedTabsByWorktree: {},
    unreadTerminalTabs: {},
    sortEpoch: 0,
    ...overrides
  }
}

function makeSnapshot(
  tabs: RuntimeMobileSessionTabsResult['tabs'],
  overrides: Partial<RuntimeMobileSessionTabsResult> = {}
): RuntimeMobileSessionTabsResult {
  return {
    worktree: WT,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'host-group-1',
    activeTabId: tabs.find((tab) => tab.type === 'terminal' && tab.isActive)?.id ?? null,
    activeTabType: 'terminal',
    tabs,
    ...overrides
  }
}

import type * as WebRuntimeSessionModule from '../web-runtime-session'
import { TERMINAL_DOCK_ECHO_WINDOW_MS } from '../../store/slices/fork-terminal-dock/tab-terminal-dock-state'
import {
  hasTerminalDockPaneState,
  readTerminalDockPaneState,
  writeTerminalDockPaneState
} from '../../components/terminal-pane/fork-terminal-dock/terminal-dock-pane-state'

const setWebRuntimeTabPropsMock = vi.fn()
vi.mock('../web-runtime-session', async (importOriginal) => {
  const actual = await importOriginal<typeof WebRuntimeSessionModule>()
  return {
    ...actual,
    setWebRuntimeTabProps: (...args: unknown[]) => setWebRuntimeTabPropsMock(...args)
  }
})

describe('applyWebSessionTabsSnapshot terminal dock reconciliation', () => {
  it('remaps host terminalDockByPaneKey to the mirrored tab id when this client has no prior tab', () => {
    // Host and local tab ids differ under a remote/web mirror (unlike desktop, where
    // they're the same string and this bug is invisible): the stored key must follow.
    const hostPaneKey = makePaneKey('host-tab-1', LEAF_ID)
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'zsh',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          terminalDockByPaneKey: { [hostPaneKey]: { docked: true, gutterRows: 8 } },
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const mirroredId = patch.tabsByWorktree?.[WT]?.[0]?.id
    expect(
      patch.unifiedTabsByWorktree?.[WT]?.find((tab) => tab.entityId === mirroredId)
        ?.terminalDockByPaneKey
    ).toEqual({ [makePaneKey(mirroredId!, LEAF_ID)]: { docked: true, gutterRows: 8 } })
  })

  it('drops an inbound dock record entry whose key does not parse as a pane key', () => {
    const hostPaneKey = makePaneKey('host-tab-1', LEAF_ID)
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'zsh',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          terminalDockByPaneKey: {
            [hostPaneKey]: { docked: true, gutterRows: 8 },
            'not-a-pane-key': { docked: false, gutterRows: 5 }
          },
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const mirroredId = patch.tabsByWorktree?.[WT]?.[0]?.id
    expect(
      patch.unifiedTabsByWorktree?.[WT]?.find((tab) => tab.entityId === mirroredId)
        ?.terminalDockByPaneKey
    ).toEqual({ [makePaneKey(mirroredId!, LEAF_ID)]: { docked: true, gutterRows: 8 } })
  })

  it('carries a provisional tab dock record across a host handoff, re-keyed to the replacement tab id', () => {
    // P2: the provisional tab's own unified-tab record is its only copy of the user's
    // optimistic dock choice; the handoff must re-key it onto the replacement instead
    // of letting the in-flight host snapshot (with no dock field yet) erase it.
    const provisionalTabId = 'provisional-dock'
    const provisionalPaneKey = makePaneKey(provisionalTabId, LEAF_ID)
    recordWebAgentSessionHandoff({
      environmentId: ENV,
      worktreeId: WT,
      provisionalTabId,
      hostTabId: 'host-tab-1',
      hostTerminalHandle: 'term_host-1'
    })
    const provisionalTerminalTab: TerminalTab = {
      id: provisionalTabId,
      ptyId: null,
      worktreeId: WT,
      title: 'Claude',
      defaultTitle: 'Claude',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      launchAgent: 'claude'
    }
    const provisionalUnifiedTab: Tab = {
      id: provisionalTabId,
      entityId: provisionalTabId,
      groupId: 'g-1',
      worktreeId: WT,
      contentType: 'terminal',
      label: 'Claude',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      isPreview: false,
      isPinned: false,
      terminalDockByPaneKey: { [provisionalPaneKey]: { docked: true, gutterRows: 5 } }
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: { [WT]: [provisionalTerminalTab] },
        unifiedTabsByWorktree: { [WT]: [provisionalUnifiedTab] }
      }),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'Claude',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          launchAgent: 'claude',
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const mirroredId = patch.tabsByWorktree?.[WT]?.[0]?.id
    expect(mirroredId).not.toBe(provisionalTabId)
    expect(
      patch.unifiedTabsByWorktree?.[WT]?.find((tab) => tab.entityId === mirroredId)
        ?.terminalDockByPaneKey
    ).toEqual({ [makePaneKey(mirroredId!, LEAF_ID)]: { docked: true, gutterRows: 5 } })
  })

  it('rekeys the pending-mutation timestamp through handoff so a stale echo still loses to it (r3-5)', () => {
    // The provisional tab's pending-mutation timestamp must follow the same
    // provisional->final rekey the dock record gets, or a later stale host echo
    // finds no timestamp under the new key and overwrites the optimistic value.
    const provisionalTabId = 'provisional-dock-r3-5'
    const hostTabId = 'host-tab-1'
    const provisionalPaneKey = makePaneKey(provisionalTabId, LEAF_ID)
    recordWebAgentSessionHandoff({
      environmentId: ENV,
      worktreeId: WT,
      provisionalTabId,
      hostTabId,
      hostTerminalHandle: 'term_host-1'
    })
    const provisionalTerminalTab: TerminalTab = {
      id: provisionalTabId,
      ptyId: null,
      worktreeId: WT,
      title: 'Claude',
      defaultTitle: 'Claude',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      launchAgent: 'claude'
    }
    const provisionalUnifiedTab: Tab = {
      id: provisionalTabId,
      entityId: provisionalTabId,
      groupId: 'g-1',
      worktreeId: WT,
      contentType: 'terminal',
      label: 'Claude',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      isPreview: false,
      isPinned: false,
      terminalDockByPaneKey: { [provisionalPaneKey]: { docked: true, gutterRows: 5 } }
    }

    const initialState = makeState({
      tabsByWorktree: { [WT]: [provisionalTerminalTab] },
      unifiedTabsByWorktree: { [WT]: [provisionalUnifiedTab] },
      terminalDockPendingMutationsByPaneKey: { [provisionalPaneKey]: NOW }
    })

    const handoffPatch = applyWebSessionTabsSnapshot(
      initialState,
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'Claude',
          parentTabId: hostTabId,
          leafId: LEAF_ID,
          isActive: true,
          launchAgent: 'claude',
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const mirroredId = handoffPatch.tabsByWorktree?.[WT]?.[0]?.id
    expect(mirroredId).not.toBe(provisionalTabId)
    const finalPaneKey = makePaneKey(mirroredId!, LEAF_ID)
    expect(handoffPatch.terminalDockPendingMutationsByPaneKey?.[finalPaneKey]).toBe(NOW)

    const stateAfterHandoff = { ...initialState, ...handoffPatch }

    // A stale host echo, still built before the RPC landed, carrying the pre-mutation value.
    const reconcilePatch = applyWebSessionTabsSnapshot(
      stateAfterHandoff,
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'Claude',
          parentTabId: hostTabId,
          leafId: LEAF_ID,
          isActive: true,
          launchAgent: 'claude',
          terminalDockByPaneKey: {
            [makePaneKey(hostTabId, LEAF_ID)]: { docked: false, gutterRows: 12 }
          },
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW + 500
    ) as Partial<WebSessionTabsSyncState>

    const stateAfterReconcile = { ...stateAfterHandoff, ...reconcilePatch }
    expect(
      stateAfterReconcile.unifiedTabsByWorktree?.[WT]?.find((tab) => tab.entityId === mirroredId)
        ?.terminalDockByPaneKey
    ).toEqual({ [finalPaneKey]: { docked: true, gutterRows: 5 } })
  })

  describe('localStorage dock fallback rekey on handoff (r5-6)', () => {
    // Why: this suite runs under Vitest's node environment (no jsdom/happy-dom), so terminal-dock-
    // pane-state's `window.localStorage` calls need a stand-in to exercise, matching the module's
    // own try/catch-guarded access pattern.
    const fakeLocalStorage = (() => {
      let entries = new Map<string, string>()
      return {
        getItem: (key: string): string | null => entries.get(key) ?? null,
        setItem: (key: string, value: string): void => {
          entries.set(key, value)
        },
        removeItem: (key: string): void => {
          entries.delete(key)
        },
        clear: (): void => {
          entries = new Map()
        }
      }
    })()

    beforeEach(() => {
      fakeLocalStorage.clear()
      ;(globalThis as { window?: unknown }).window = { localStorage: fakeLocalStorage }
    })

    afterEach(() => {
      delete (globalThis as { window?: unknown }).window
    })

    function provisionalTerminalTab(id: string): TerminalTab {
      return {
        id,
        ptyId: null,
        worktreeId: WT,
        title: 'Claude',
        defaultTitle: 'Claude',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: NOW,
        launchAgent: 'claude'
      }
    }

    it('moves the fallback entry to the replacement tab id on handoff', () => {
      const provisionalTabId = 'provisional-dock-r5-6'
      const hostTabId = 'host-tab-1'
      const provisionalPaneKey = makePaneKey(provisionalTabId, LEAF_ID)
      writeTerminalDockPaneState(provisionalPaneKey, { docked: true, gutterRows: 9 })
      recordWebAgentSessionHandoff({
        environmentId: ENV,
        worktreeId: WT,
        provisionalTabId,
        hostTabId,
        hostTerminalHandle: 'term_host-1'
      })

      applyWebSessionTabsSnapshot(
        makeState({ tabsByWorktree: { [WT]: [provisionalTerminalTab(provisionalTabId)] } }),
        makeSnapshot([
          {
            type: 'terminal',
            id: HOST_SURFACE_ID,
            title: 'Claude',
            parentTabId: hostTabId,
            leafId: LEAF_ID,
            isActive: true,
            launchAgent: 'claude',
            status: 'ready',
            terminal: 'terminal-1'
          }
        ]),
        ENV,
        NOW
      )

      const finalPaneKey = makePaneKey(toWebTerminalSurfaceTabId(hostTabId), LEAF_ID)
      expect(hasTerminalDockPaneState(provisionalPaneKey)).toBe(false)
      expect(readTerminalDockPaneState(finalPaneKey)).toEqual({ docked: true, gutterRows: 9 })
    })

    it('keeps the pre-existing final-key entry on collision and still drops the source', () => {
      const provisionalTabId = 'provisional-dock-r5-6-collision'
      const hostTabId = 'host-tab-1'
      const provisionalPaneKey = makePaneKey(provisionalTabId, LEAF_ID)
      const finalPaneKey = makePaneKey(toWebTerminalSurfaceTabId(hostTabId), LEAF_ID)
      writeTerminalDockPaneState(provisionalPaneKey, { docked: true, gutterRows: 9 })
      // Newer, written under the pane's true final identity — must win over the
      // provisional-keyed value it would otherwise be clobbered by.
      writeTerminalDockPaneState(finalPaneKey, { docked: false, gutterRows: 3 })
      recordWebAgentSessionHandoff({
        environmentId: ENV,
        worktreeId: WT,
        provisionalTabId,
        hostTabId,
        hostTerminalHandle: 'term_host-1'
      })

      applyWebSessionTabsSnapshot(
        makeState({ tabsByWorktree: { [WT]: [provisionalTerminalTab(provisionalTabId)] } }),
        makeSnapshot([
          {
            type: 'terminal',
            id: HOST_SURFACE_ID,
            title: 'Claude',
            parentTabId: hostTabId,
            leafId: LEAF_ID,
            isActive: true,
            launchAgent: 'claude',
            status: 'ready',
            terminal: 'terminal-1'
          }
        ]),
        ENV,
        NOW
      )

      expect(hasTerminalDockPaneState(provisionalPaneKey)).toBe(false)
      expect(readTerminalDockPaneState(finalPaneKey)).toEqual({ docked: false, gutterRows: 3 })
    })

    it('leaves localStorage untouched when the experimental flag is off', () => {
      const provisionalTabId = 'provisional-dock-r5-6-flag-off'
      const hostTabId = 'host-tab-1'
      const provisionalPaneKey = makePaneKey(provisionalTabId, LEAF_ID)
      writeTerminalDockPaneState(provisionalPaneKey, { docked: true, gutterRows: 9 })
      recordWebAgentSessionHandoff({
        environmentId: ENV,
        worktreeId: WT,
        provisionalTabId,
        hostTabId,
        hostTerminalHandle: 'term_host-1'
      })

      applyWebSessionTabsSnapshot(
        makeState({
          tabsByWorktree: { [WT]: [provisionalTerminalTab(provisionalTabId)] },
          settings: { experimentalTerminalDock: false } as GlobalSettings
        }),
        makeSnapshot([
          {
            type: 'terminal',
            id: HOST_SURFACE_ID,
            title: 'Claude',
            parentTabId: hostTabId,
            leafId: LEAF_ID,
            isActive: true,
            launchAgent: 'claude',
            status: 'ready',
            terminal: 'terminal-1'
          }
        ]),
        ENV,
        NOW
      )

      const finalPaneKey = makePaneKey(toWebTerminalSurfaceTabId(hostTabId), LEAF_ID)
      expect(readTerminalDockPaneState(provisionalPaneKey)).toEqual({ docked: true, gutterRows: 9 })
      expect(hasTerminalDockPaneState(finalPaneKey)).toBe(false)
    })
  })

  it('adopts host terminalDockByPaneKey for an existing tab with no local dock record', () => {
    const mirroredId = toWebTerminalSurfaceTabId('host-tab-1')
    const existingTab: TerminalTab = {
      id: mirroredId,
      ptyId: 'remote:web-env-1@@terminal-1',
      worktreeId: WT,
      title: 'old title',
      defaultTitle: 'old title',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW
    }
    const existingUnifiedTab: Tab = {
      id: mirroredId,
      entityId: mirroredId,
      groupId: 'host-group-1',
      worktreeId: WT,
      contentType: 'terminal',
      label: 'old title',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      isPreview: false,
      isPinned: false
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: { [WT]: [existingTab] },
        ptyIdsByTabId: { [mirroredId]: ['remote:web-env-1@@terminal-1'] },
        unifiedTabsByWorktree: { [WT]: [existingUnifiedTab] }
      }),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'new title',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          terminalDockByPaneKey: {
            [makePaneKey('host-tab-1', LEAF_ID)]: { docked: true, gutterRows: 8 }
          },
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW + 1
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.tabsByWorktree?.[WT]?.[0]?.title).toBe('new title')
    expect(
      patch.unifiedTabsByWorktree?.[WT]?.find((tab) => tab.entityId === mirroredId)
        ?.terminalDockByPaneKey
    ).toEqual({
      [makePaneKey(mirroredId, LEAF_ID)]: { docked: true, gutterRows: 8 }
    })
  })

  it('adopts a changed host terminalDockByPaneKey so paired clients converge', () => {
    const mirroredId = toWebTerminalSurfaceTabId('host-tab-1')
    const mirroredPaneKey = makePaneKey(mirroredId, LEAF_ID)
    const hostPaneKey = makePaneKey('host-tab-1', LEAF_ID)
    const existingTab: TerminalTab = {
      id: mirroredId,
      ptyId: 'remote:web-env-1@@terminal-1',
      worktreeId: WT,
      title: 'old title',
      defaultTitle: 'old title',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW
    }
    const existingUnifiedTab: Tab = {
      id: mirroredId,
      entityId: mirroredId,
      groupId: 'host-group-1',
      worktreeId: WT,
      contentType: 'terminal',
      label: 'old title',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      isPreview: false,
      isPinned: false,
      terminalDockByPaneKey: { [mirroredPaneKey]: { docked: true, gutterRows: 6 } }
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: { [WT]: [existingTab] },
        ptyIdsByTabId: { [mirroredId]: ['remote:web-env-1@@terminal-1'] },
        unifiedTabsByWorktree: { [WT]: [existingUnifiedTab] }
      }),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'new title',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          terminalDockByPaneKey: { [hostPaneKey]: { docked: false, gutterRows: 12 } },
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW + 1
    ) as Partial<WebSessionTabsSyncState>

    expect(
      patch.unifiedTabsByWorktree?.[WT]?.find((tab) => tab.entityId === mirroredId)
        ?.terminalDockByPaneKey
    ).toEqual({ [mirroredPaneKey]: { docked: false, gutterRows: 12 } })
  })

  it('falls back to the client terminalDockByPaneKey when an old host omits the field', () => {
    // Wire-skew: new client + old host. The host strips the unknown field, so no
    // surface ever carries it; detection is "the field never echoes back."
    const mirroredId = toWebTerminalSurfaceTabId('host-tab-1')
    const existingTab: TerminalTab = {
      id: mirroredId,
      ptyId: 'remote:web-env-1@@terminal-1',
      worktreeId: WT,
      title: 'zsh',
      defaultTitle: 'zsh',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW
    }
    const existingUnifiedTab: Tab = {
      id: mirroredId,
      entityId: mirroredId,
      groupId: 'host-group-1',
      worktreeId: WT,
      contentType: 'terminal',
      label: 'zsh',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      isPreview: false,
      isPinned: false,
      terminalDockByPaneKey: { 'pane-a': { docked: true, gutterRows: 6 } }
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: { [WT]: [existingTab] },
        ptyIdsByTabId: { [mirroredId]: ['remote:web-env-1@@terminal-1'] },
        unifiedTabsByWorktree: { [WT]: [existingUnifiedTab] }
      }),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          // Title differs so the reconcile emits a real delta; an unchanged
          // snapshot would reuse the prior array reference and prove nothing.
          title: 'new title',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW + 1
    ) as Partial<WebSessionTabsSyncState>

    expect(
      patch.unifiedTabsByWorktree?.[WT]?.find((tab) => tab.entityId === mirroredId)
        ?.terminalDockByPaneKey
    ).toEqual({ 'pane-a': { docked: true, gutterRows: 6 } })
    // Falling back to local persistence must not re-trigger an outbound mirror (no thrash).
    expect(setWebRuntimeTabPropsMock).not.toHaveBeenCalled()
  })

  it('treats an explicitly echoed empty dock record as host-authoritative, not as an absent field', () => {
    // A modern host that pruned its last dock entry publishes {}; that must win over a
    // stale local record instead of reading as "old host never echoed the field."
    const mirroredId = toWebTerminalSurfaceTabId('host-tab-1')
    const existingTab: TerminalTab = {
      id: mirroredId,
      ptyId: 'remote:web-env-1@@terminal-1',
      worktreeId: WT,
      title: 'zsh',
      defaultTitle: 'zsh',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW
    }
    const existingUnifiedTab: Tab = {
      id: mirroredId,
      entityId: mirroredId,
      groupId: 'host-group-1',
      worktreeId: WT,
      contentType: 'terminal',
      label: 'zsh',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      isPreview: false,
      isPinned: false,
      terminalDockByPaneKey: { 'pane-a': { docked: true, gutterRows: 6 } }
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: { [WT]: [existingTab] },
        ptyIdsByTabId: { [mirroredId]: ['remote:web-env-1@@terminal-1'] },
        unifiedTabsByWorktree: { [WT]: [existingUnifiedTab] }
      }),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'new title',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          terminalDockByPaneKey: {},
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW + 1
    ) as Partial<WebSessionTabsSyncState>

    expect(
      patch.unifiedTabsByWorktree?.[WT]?.find((tab) => tab.entityId === mirroredId)
        ?.terminalDockByPaneKey
    ).toEqual({})
  })

  it('does not adopt host dock state, but keeps the client record untouched, with the kill switch off', () => {
    const mirroredId = toWebTerminalSurfaceTabId('host-tab-1')
    const existingTab: TerminalTab = {
      id: mirroredId,
      ptyId: 'remote:web-env-1@@terminal-1',
      worktreeId: WT,
      title: 'zsh',
      defaultTitle: 'zsh',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW
    }
    const existingUnifiedTab: Tab = {
      id: mirroredId,
      entityId: mirroredId,
      groupId: 'host-group-1',
      worktreeId: WT,
      contentType: 'terminal',
      label: 'zsh',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      isPreview: false,
      isPinned: false,
      // Why: persisted by a flag-on peer; a flag-off client reconciling this snapshot must not clobber it.
      terminalDockByPaneKey: { 'pane-a': { docked: true, gutterRows: 6 } }
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        settings: { experimentalTerminalDock: false } as GlobalSettings,
        tabsByWorktree: { [WT]: [existingTab] },
        ptyIdsByTabId: { [mirroredId]: ['remote:web-env-1@@terminal-1'] },
        unifiedTabsByWorktree: { [WT]: [existingUnifiedTab] }
      }),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'new title',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          terminalDockByPaneKey: {
            [makePaneKey('host-tab-1', LEAF_ID)]: { docked: false, gutterRows: 12 }
          },
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW + 1
    ) as Partial<WebSessionTabsSyncState>

    expect(
      patch.unifiedTabsByWorktree?.[WT]?.find((tab) => tab.entityId === mirroredId)
        ?.terminalDockByPaneKey
    ).toEqual({ 'pane-a': { docked: true, gutterRows: 6 } })
  })

  it('never mirrors to the host while reconciling a snapshot, even when the host publishes dock state', () => {
    applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'zsh',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          terminalDockByPaneKey: { 'host-tab-1:pane-a': { docked: true, gutterRows: 8 } },
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW
    )

    expect(setWebRuntimeTabPropsMock).not.toHaveBeenCalled()
  })

  it('never mirrors a removal back to the host when a locally pruned pane is still present in the host echo', () => {
    // The client already pruned 'pane-b' via the store action (out of band, mirrored
    // separately); the host's snapshot hasn't caught up and still echoes both panes.
    // Reconcile must not react to that stale echo by firing an outbound removal.
    const mirroredId = toWebTerminalSurfaceTabId('host-tab-1')
    const existingTab: TerminalTab = {
      id: mirroredId,
      ptyId: 'remote:web-env-1@@terminal-1',
      worktreeId: WT,
      title: 'zsh',
      defaultTitle: 'zsh',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW
    }
    const existingUnifiedTab: Tab = {
      id: mirroredId,
      entityId: mirroredId,
      groupId: 'host-group-1',
      worktreeId: WT,
      contentType: 'terminal',
      label: 'zsh',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      isPreview: false,
      isPinned: false,
      terminalDockByPaneKey: { 'pane-a': { docked: true, gutterRows: 6 } }
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: { [WT]: [existingTab] },
        ptyIdsByTabId: { [mirroredId]: ['remote:web-env-1@@terminal-1'] },
        unifiedTabsByWorktree: { [WT]: [existingUnifiedTab] }
      }),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'new title',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          terminalDockByPaneKey: {
            'host-tab-1:pane-a': { docked: true, gutterRows: 6 },
            'host-tab-1:pane-b': { docked: false, gutterRows: 8 }
          },
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW + 1
    ) as Partial<WebSessionTabsSyncState>

    expect(
      patch.unifiedTabsByWorktree?.[WT]?.find((tab) => tab.entityId === mirroredId)
        ?.terminalDockByPaneKey
    ).toEqual({ 'pane-a': { docked: true, gutterRows: 6 } })
    expect(setWebRuntimeTabPropsMock).not.toHaveBeenCalled()
  })

  it('keeps a pane with a pending local dock mutation against a stale host echo, but still adopts a changed host value for a pane with no pending intent', () => {
    // r2-2: an in-flight snapshot built before the client's own RPC lands must not
    // revert the pane it just touched, while an unrelated pane still converges.
    const mirroredId = toWebTerminalSurfaceTabId('host-tab-1')
    const pendingPaneKey = makePaneKey(mirroredId, LEAF_ID)
    const otherPaneKey = makePaneKey(mirroredId, SECOND_LEAF_ID)
    const hostPendingPaneKey = makePaneKey('host-tab-1', LEAF_ID)
    const hostOtherPaneKey = makePaneKey('host-tab-1', SECOND_LEAF_ID)
    const existingTab: TerminalTab = {
      id: mirroredId,
      ptyId: 'remote:web-env-1@@terminal-1',
      worktreeId: WT,
      title: 'zsh',
      defaultTitle: 'zsh',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW
    }
    const existingUnifiedTab: Tab = {
      id: mirroredId,
      entityId: mirroredId,
      groupId: 'host-group-1',
      worktreeId: WT,
      contentType: 'terminal',
      label: 'zsh',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      isPreview: false,
      isPinned: false,
      terminalDockByPaneKey: {
        [pendingPaneKey]: { docked: true, gutterRows: 6 },
        [otherPaneKey]: { docked: true, gutterRows: 5 }
      }
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: { [WT]: [existingTab] },
        ptyIdsByTabId: { [mirroredId]: ['remote:web-env-1@@terminal-1'] },
        unifiedTabsByWorktree: { [WT]: [existingUnifiedTab] },
        terminalDockPendingMutationsByPaneKey: { [pendingPaneKey]: NOW }
      }),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'new title',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          terminalDockByPaneKey: {
            // Why: pre-dates the client's own toggle — the stale snapshot main built
            // before the RPC landed.
            [hostPendingPaneKey]: { docked: false, gutterRows: 12 },
            [hostOtherPaneKey]: { docked: false, gutterRows: 9 }
          },
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW + 500
    ) as Partial<WebSessionTabsSyncState>

    expect(
      patch.unifiedTabsByWorktree?.[WT]?.find((tab) => tab.entityId === mirroredId)
        ?.terminalDockByPaneKey
    ).toEqual({
      [pendingPaneKey]: { docked: true, gutterRows: 6 },
      [otherPaneKey]: { docked: false, gutterRows: 9 }
    })
  })

  it('adopts the host value once a pending dock mutation is older than the echo window', () => {
    const mirroredId = toWebTerminalSurfaceTabId('host-tab-1')
    const paneKey = makePaneKey(mirroredId, LEAF_ID)
    const hostPaneKey = makePaneKey('host-tab-1', LEAF_ID)
    const existingTab: TerminalTab = {
      id: mirroredId,
      ptyId: 'remote:web-env-1@@terminal-1',
      worktreeId: WT,
      title: 'zsh',
      defaultTitle: 'zsh',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW
    }
    const existingUnifiedTab: Tab = {
      id: mirroredId,
      entityId: mirroredId,
      groupId: 'host-group-1',
      worktreeId: WT,
      contentType: 'terminal',
      label: 'zsh',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      isPreview: false,
      isPinned: false,
      terminalDockByPaneKey: { [paneKey]: { docked: true, gutterRows: 6 } }
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: { [WT]: [existingTab] },
        ptyIdsByTabId: { [mirroredId]: ['remote:web-env-1@@terminal-1'] },
        unifiedTabsByWorktree: { [WT]: [existingUnifiedTab] },
        terminalDockPendingMutationsByPaneKey: { [paneKey]: NOW }
      }),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'new title',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          terminalDockByPaneKey: { [hostPaneKey]: { docked: false, gutterRows: 12 } },
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW + TERMINAL_DOCK_ECHO_WINDOW_MS + 1
    ) as Partial<WebSessionTabsSyncState>

    expect(
      patch.unifiedTabsByWorktree?.[WT]?.find((tab) => tab.entityId === mirroredId)
        ?.terminalDockByPaneKey
    ).toEqual({ [paneKey]: { docked: false, gutterRows: 12 } })
  })

  it('prunes expired pending-mutation timestamps on the next consult, bounding the record (r3-6)', () => {
    const mirroredId = toWebTerminalSurfaceTabId('host-tab-1')
    const expiredPaneKey = makePaneKey('some-closed-tab', SECOND_LEAF_ID)
    const freshPaneKey = makePaneKey(mirroredId, LEAF_ID)

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        terminalDockPendingMutationsByPaneKey: {
          [expiredPaneKey]: NOW,
          [freshPaneKey]: NOW + 500
        }
      }),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'zsh',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW + TERMINAL_DOCK_ECHO_WINDOW_MS + 1
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.terminalDockPendingMutationsByPaneKey).toEqual({ [freshPaneKey]: NOW + 500 })
  })
})
