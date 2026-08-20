import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Tab } from '../../../../../shared/types'
import type * as AgentStatusModule from '@/lib/agent-status'
import type * as WorktreeRuntimeOwnerModule from '@/lib/worktree-runtime-owner'
import type * as WebRuntimeSessionModule from '@/runtime/web-runtime-session'
import { toWebTerminalSurfaceTabId } from '@/runtime/web-terminal-surface-id'
import { makePaneKey } from '../../../../../shared/stable-pane-id'
import { TERMINAL_DOCK_ECHO_WINDOW_MS } from '@/runtime/fork-terminal-dock/web-session-terminal-dock-reconcile'

// Mock sonner (imported by repos.ts)
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

// Mock agent-status (imported by terminal-helpers)
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

const getRuntimeEnvironmentIdForWorktreeMock = vi.fn<(...args: unknown[]) => string | null>(
  () => null
)
vi.mock('@/lib/worktree-runtime-owner', async (importOriginal) => {
  const actual = await importOriginal<typeof WorktreeRuntimeOwnerModule>()
  return {
    ...actual,
    getRuntimeEnvironmentIdForWorktree: (...args: unknown[]) =>
      getRuntimeEnvironmentIdForWorktreeMock(...args)
  }
})

// Why: setWebRuntimeTabProps (real impl, imported via vi.importActual below) reads
// useAppStore.getState() directly; stub it so that import doesn't pull in the full
// app store composition just to satisfy a call whose result the mocked
// getRuntimeEnvironmentIdForWorktree above ignores anyway.
vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn(() => ({})), setState: vi.fn() } }))

const setWebRuntimeTabPropsMock = vi.fn()
vi.mock('@/runtime/web-runtime-session', async (importOriginal) => {
  const actual = await importOriginal<typeof WebRuntimeSessionModule>()
  return {
    ...actual,
    setWebRuntimeTabProps: (...args: unknown[]) => setWebRuntimeTabPropsMock(...args)
  }
})

const mockApi = {
  worktrees: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue(undefined),
    updateMeta: vi.fn().mockResolvedValue({})
  },
  repos: {
    list: vi.fn().mockResolvedValue([]),
    add: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue({}),
    pickFolder: vi.fn().mockResolvedValue(null)
  },
  pty: {
    kill: vi.fn().mockResolvedValue(undefined),
    spawn: vi.fn().mockResolvedValue({ id: 'pty-1' })
  },
  gh: {
    prForBranch: vi.fn().mockResolvedValue(null),
    issue: vi.fn().mockResolvedValue(null)
  },
  settings: {
    get: vi.fn().mockResolvedValue({}),
    set: vi.fn().mockResolvedValue(undefined)
  },
  ui: {
    set: vi.fn().mockResolvedValue(undefined)
  },
  cache: {
    getGitHub: vi.fn().mockResolvedValue(null),
    setGitHub: vi.fn().mockResolvedValue(undefined)
  },
  claudeUsage: {
    getScanState: vi.fn().mockResolvedValue({
      enabled: false,
      isScanning: false,
      lastScanStartedAt: null,
      lastScanCompletedAt: null,
      lastScanError: null,
      hasAnyClaudeData: false
    }),
    setEnabled: vi.fn().mockResolvedValue({}),
    refresh: vi.fn().mockResolvedValue({}),
    getSummary: vi.fn().mockResolvedValue(null),
    getDaily: vi.fn().mockResolvedValue([]),
    getBreakdown: vi.fn().mockResolvedValue([]),
    getRecentSessions: vi.fn().mockResolvedValue([])
  },
  codexUsage: {
    getScanState: vi.fn().mockResolvedValue({
      enabled: false,
      isScanning: false,
      lastScanStartedAt: null,
      lastScanCompletedAt: null,
      lastScanError: null,
      hasAnyCodexData: false
    }),
    setEnabled: vi.fn().mockResolvedValue({}),
    refresh: vi.fn().mockResolvedValue({}),
    getSummary: vi.fn().mockResolvedValue(null),
    getDaily: vi.fn().mockResolvedValue([]),
    getBreakdown: vi.fn().mockResolvedValue([]),
    getRecentSessions: vi.fn().mockResolvedValue([])
  },
  openCodeUsage: {
    getScanState: vi.fn().mockResolvedValue({
      enabled: false,
      isScanning: false,
      lastScanStartedAt: null,
      lastScanCompletedAt: null,
      lastScanError: null,
      hasAnyOpenCodeData: false
    }),
    setEnabled: vi.fn().mockResolvedValue({}),
    refresh: vi.fn().mockResolvedValue({}),
    getSummary: vi.fn().mockResolvedValue(null),
    getDaily: vi.fn().mockResolvedValue([]),
    getBreakdown: vi.fn().mockResolvedValue([]),
    getRecentSessions: vi.fn().mockResolvedValue([])
  }
}

// @ts-expect-error -- mock
globalThis.window = { api: mockApi }

import { createTestStore, makeTabGroup, makeUnifiedTab } from '../store-test-helpers'

const WT = 'repo1::/tmp/feature'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

describe('TabsSlice terminal dock state', () => {
  let store: ReturnType<typeof createTestStore>

  beforeEach(() => {
    store = createTestStore()
  })

  // ─── setTabTerminalDockState / pruneTerminalDockPaneKeys ─────────────

  describe('terminal dock state', () => {
    beforeEach(() => {
      getRuntimeEnvironmentIdForWorktreeMock.mockReset()
      getRuntimeEnvironmentIdForWorktreeMock.mockReturnValue(null)
      setWebRuntimeTabPropsMock.mockReset()
    })

    function seedDockTab(overrides: Partial<Tab> = {}): Tab {
      const tab = makeUnifiedTab({
        id: 'dock-tab-1',
        worktreeId: WT,
        groupId: 'g-dock',
        contentType: 'terminal',
        ...overrides
      })
      store.setState({
        unifiedTabsByWorktree: { [WT]: [tab] },
        groupsByWorktree: {
          [WT]: [
            makeTabGroup({
              id: 'g-dock',
              worktreeId: WT,
              activeTabId: tab.id,
              tabOrder: [tab.id]
            })
          ]
        }
      })
      return tab
    }

    it('patches the pane entry, defaulting unspecified fields', () => {
      seedDockTab()
      store
        .getState()
        .setTabTerminalDockState('dock-tab-1', { paneKey: 'dock-tab-1:1', docked: true })

      expect(store.getState().getTab('dock-tab-1')?.terminalDockByPaneKey).toEqual({
        'dock-tab-1:1': { docked: true, gutterRows: 5 }
      })
    })

    it('merges a second patch onto the same pane without disturbing other panes', () => {
      seedDockTab()
      store
        .getState()
        .setTabTerminalDockState('dock-tab-1', { paneKey: 'pane-a', docked: true, gutterRows: 8 })
      store.getState().setTabTerminalDockState('dock-tab-1', { paneKey: 'pane-b', docked: false })
      store.getState().setTabTerminalDockState('dock-tab-1', { paneKey: 'pane-a', gutterRows: 10 })

      expect(store.getState().getTab('dock-tab-1')?.terminalDockByPaneKey).toEqual({
        'pane-a': { docked: true, gutterRows: 10 },
        'pane-b': { docked: false, gutterRows: 5 }
      })
    })

    it('mirrors only the single-pane patch to the host', async () => {
      seedDockTab()
      getRuntimeEnvironmentIdForWorktreeMock.mockReturnValue('env-1')
      const paneKey = makePaneKey('dock-tab-1', LEAF_ID)

      store
        .getState()
        .setTabTerminalDockState('dock-tab-1', { paneKey, docked: true, gutterRows: 9 })

      await vi.waitFor(() => expect(setWebRuntimeTabPropsMock).toHaveBeenCalledTimes(1))
      expect(setWebRuntimeTabPropsMock).toHaveBeenCalledWith({
        worktreeId: WT,
        tabId: 'dock-tab-1',
        terminalDock: { paneKey, docked: true, gutterRows: 9 }
      })
    })

    it('remaps the outbound pane key to the host tab id for a mirrored terminal', async () => {
      // P1: the RPC's tabId is translated back to the host id; the paneKey's tab-ID
      // segment must follow, or the host accumulates a second, web-namespaced record.
      const mirroredTabId = toWebTerminalSurfaceTabId('host-tab-9')
      seedDockTab({ id: mirroredTabId })
      getRuntimeEnvironmentIdForWorktreeMock.mockReturnValue('env-1')
      const localPaneKey = makePaneKey(mirroredTabId, LEAF_ID)

      store
        .getState()
        .setTabTerminalDockState(mirroredTabId, { paneKey: localPaneKey, docked: true })

      await vi.waitFor(() => expect(setWebRuntimeTabPropsMock).toHaveBeenCalledTimes(1))
      expect(setWebRuntimeTabPropsMock).toHaveBeenCalledWith({
        worktreeId: WT,
        tabId: mirroredTabId,
        terminalDock: { paneKey: makePaneKey('host-tab-9', LEAF_ID), docked: true }
      })
    })

    it('clamps an out-of-range gutterRows locally and mirrors the clamped value', async () => {
      seedDockTab()
      getRuntimeEnvironmentIdForWorktreeMock.mockReturnValue('env-1')
      const paneKey = makePaneKey('dock-tab-1', LEAF_ID)

      store.getState().setTabTerminalDockState('dock-tab-1', { paneKey, gutterRows: 999 })

      expect(store.getState().getTab('dock-tab-1')?.terminalDockByPaneKey).toEqual({
        [paneKey]: { docked: false, gutterRows: 15 }
      })
      await vi.waitFor(() => expect(setWebRuntimeTabPropsMock).toHaveBeenCalledTimes(1))
      expect(setWebRuntimeTabPropsMock).toHaveBeenCalledWith({
        worktreeId: WT,
        tabId: 'dock-tab-1',
        terminalDock: { paneKey, gutterRows: 15 }
      })
    })

    it('clamps a below-range gutterRows to the minimum', () => {
      seedDockTab()
      const paneKey = makePaneKey('dock-tab-1', LEAF_ID)
      store.getState().setTabTerminalDockState('dock-tab-1', { paneKey, gutterRows: 0 })

      expect(store.getState().getTab('dock-tab-1')?.terminalDockByPaneKey).toEqual({
        [paneKey]: { docked: false, gutterRows: 3 }
      })
    })

    it('falls back to the default for a non-finite gutterRows instead of propagating it', () => {
      seedDockTab()
      const paneKey = makePaneKey('dock-tab-1', LEAF_ID)
      store.getState().setTabTerminalDockState('dock-tab-1', { paneKey, gutterRows: Number.NaN })

      expect(store.getState().getTab('dock-tab-1')?.terminalDockByPaneKey).toEqual({
        [paneKey]: { docked: false, gutterRows: 5 }
      })
    })

    it('forwards the terminalDock patch all the way onto the outbound RPC params', async () => {
      // Why: the mock above only proves tabs.ts *calls* setWebRuntimeTabProps with the
      // patch; it says nothing about whether that function forwards the field onto the
      // wire. Use the real implementation here to close that specific gap.
      getRuntimeEnvironmentIdForWorktreeMock.mockReturnValue('env-1')
      const runtimeCall = vi
        .fn()
        .mockResolvedValue({ id: 'p', ok: true, result: { updated: true } })
      vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

      const real = await vi.importActual<typeof WebRuntimeSessionModule>(
        '@/runtime/web-runtime-session'
      )

      expect(
        real.setWebRuntimeTabProps({
          worktreeId: WT,
          tabId: 'dock-tab-1',
          terminalDock: { paneKey: 'pane-a', docked: true, gutterRows: 9 }
        })
      ).toBe(true)

      await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledTimes(1))
      expect(runtimeCall).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'session.tabs.setTabProps',
        params: {
          worktree: `id:${WT}`,
          tabId: 'dock-tab-1',
          terminalDock: { paneKey: 'pane-a', docked: true, gutterRows: 9 }
        },
        timeoutMs: 15_000
      })

      vi.unstubAllGlobals()
      // Restore the mockApi-backed window the rest of this file's tests depend on.
      // @ts-expect-error -- partial window stub is sufficient for these store-only tests
      globalThis.window = { api: mockApi }
    })

    it('does not mirror to the host without a runtime environment for the worktree', () => {
      seedDockTab()
      store.getState().setTabTerminalDockState('dock-tab-1', { paneKey: 'pane-a', docked: true })

      expect(setWebRuntimeTabPropsMock).not.toHaveBeenCalled()
    })

    it('is a no-op for an unknown tab id', () => {
      const before = store.getState().unifiedTabsByWorktree[WT]
      store.getState().setTabTerminalDockState('missing-tab', { paneKey: 'pane-a', docked: true })
      expect(store.getState().unifiedTabsByWorktree[WT]).toBe(before)
    })

    it('drops only the retired pane keys', () => {
      const tab = seedDockTab({
        terminalDockByPaneKey: {
          'pane-a': { docked: true, gutterRows: 6 },
          'pane-b': { docked: false, gutterRows: 8 },
          'pane-c': { docked: true, gutterRows: 10 }
        }
      })
      store.getState().pruneTerminalDockPaneKeys(tab.id, ['pane-a', 'pane-c'])

      expect(store.getState().getTab(tab.id)?.terminalDockByPaneKey).toEqual({
        'pane-b': { docked: false, gutterRows: 8 }
      })
    })

    it('is a no-op when no pane keys match', () => {
      seedDockTab({ terminalDockByPaneKey: { 'pane-a': { docked: true, gutterRows: 6 } } })
      const before = store.getState().unifiedTabsByWorktree[WT]
      store.getState().pruneTerminalDockPaneKeys('dock-tab-1', ['pane-z'])
      expect(store.getState().unifiedTabsByWorktree[WT]).toBe(before)
      expect(setWebRuntimeTabPropsMock).not.toHaveBeenCalled()
    })

    it('mirrors only the removed keys to the host', async () => {
      const paneKeyA = makePaneKey('dock-tab-1', LEAF_ID)
      const paneKeyB = makePaneKey('dock-tab-1', '22222222-2222-4222-8222-222222222222')
      const paneKeyC = makePaneKey('dock-tab-1', '33333333-3333-4333-8333-333333333333')
      seedDockTab({
        terminalDockByPaneKey: {
          [paneKeyA]: { docked: true, gutterRows: 6 },
          [paneKeyB]: { docked: false, gutterRows: 8 },
          [paneKeyC]: { docked: true, gutterRows: 10 }
        }
      })
      getRuntimeEnvironmentIdForWorktreeMock.mockReturnValue('env-1')

      store.getState().pruneTerminalDockPaneKeys('dock-tab-1', [paneKeyA, paneKeyC, 'pane-missing'])

      await vi.waitFor(() => expect(setWebRuntimeTabPropsMock).toHaveBeenCalledTimes(1))
      expect(setWebRuntimeTabPropsMock).toHaveBeenCalledWith({
        worktreeId: WT,
        tabId: 'dock-tab-1',
        terminalDock: { remove: [paneKeyA, paneKeyC] }
      })
    })

    it('remaps removed pane keys to the host tab id for a mirrored terminal', async () => {
      const mirroredTabId = toWebTerminalSurfaceTabId('host-tab-9')
      const localPaneKeyA = makePaneKey(mirroredTabId, LEAF_ID)
      const localPaneKeyB = makePaneKey(mirroredTabId, '22222222-2222-4222-8222-222222222222')
      seedDockTab({
        id: mirroredTabId,
        terminalDockByPaneKey: {
          [localPaneKeyA]: { docked: true, gutterRows: 6 },
          [localPaneKeyB]: { docked: false, gutterRows: 8 }
        }
      })
      getRuntimeEnvironmentIdForWorktreeMock.mockReturnValue('env-1')

      store.getState().pruneTerminalDockPaneKeys(mirroredTabId, [localPaneKeyA])

      await vi.waitFor(() => expect(setWebRuntimeTabPropsMock).toHaveBeenCalledTimes(1))
      expect(setWebRuntimeTabPropsMock).toHaveBeenCalledWith({
        worktreeId: WT,
        tabId: mirroredTabId,
        terminalDock: { remove: [makePaneKey('host-tab-9', LEAF_ID)] }
      })
    })

    it('does not mirror the removal without a runtime environment for the worktree', () => {
      seedDockTab({ terminalDockByPaneKey: { 'pane-a': { docked: true, gutterRows: 6 } } })
      store.getState().pruneTerminalDockPaneKeys('dock-tab-1', ['pane-a'])
      expect(setWebRuntimeTabPropsMock).not.toHaveBeenCalled()
    })

    it('switching a tab to chat view preserves its dock state', () => {
      seedDockTab({
        terminalDockByPaneKey: { 'pane-a': { docked: true, gutterRows: 6 } }
      })

      store.getState().setTabViewMode('dock-tab-1', 'chat')

      const tab = store.getState().getTab('dock-tab-1')
      expect(tab?.viewMode).toBe('chat')
      expect(tab?.terminalDockByPaneKey).toEqual({ 'pane-a': { docked: true, gutterRows: 6 } })
    })

    it('toggling view mode preserves dock state', () => {
      seedDockTab({
        terminalDockByPaneKey: { 'pane-a': { docked: true, gutterRows: 6 } }
      })

      store.getState().toggleTabViewMode('dock-tab-1')

      expect(store.getState().getTab('dock-tab-1')?.terminalDockByPaneKey).toEqual({
        'pane-a': { docked: true, gutterRows: 6 }
      })
    })

    it('prunes expired pending-mutation timestamps on the next stamp, bounding the record (r3-6)', () => {
      seedDockTab()
      const staleKey = 'stale-pane:1'
      const freshKey = 'fresh-pane:1'
      const now = Date.now()
      store.setState({
        terminalDockPendingMutationsByPaneKey: {
          [staleKey]: now - TERMINAL_DOCK_ECHO_WINDOW_MS - 1,
          [freshKey]: now
        }
      })

      store.getState().setTabTerminalDockState('dock-tab-1', { paneKey: 'pane-a', docked: true })

      const pending = store.getState().terminalDockPendingMutationsByPaneKey
      expect(pending[staleKey]).toBeUndefined()
      expect(pending[freshKey]).toBe(now)
      expect(pending['pane-a']).toBeDefined()
    })

    it('prunes expired pending-mutation timestamps when a pane is pruned (r3-6)', () => {
      seedDockTab({ terminalDockByPaneKey: { 'pane-a': { docked: true, gutterRows: 6 } } })
      const staleKey = 'stale-pane:1'
      const now = Date.now()
      store.setState({
        terminalDockPendingMutationsByPaneKey: {
          [staleKey]: now - TERMINAL_DOCK_ECHO_WINDOW_MS - 1
        }
      })

      store.getState().pruneTerminalDockPaneKeys('dock-tab-1', ['pane-a'])

      const pending = store.getState().terminalDockPendingMutationsByPaneKey
      expect(pending[staleKey]).toBeUndefined()
      expect(pending['pane-a']).toBeDefined()
    })

    it("clears a closed tab's pending-mutation keys so they do not linger (r3-6)", () => {
      const paneKeyA = makePaneKey('dock-tab-1', LEAF_ID)
      const otherTabPaneKey = makePaneKey('other-tab', LEAF_ID)
      seedDockTab({ terminalDockByPaneKey: { [paneKeyA]: { docked: true, gutterRows: 6 } } })
      store.setState({
        terminalDockPendingMutationsByPaneKey: {
          [paneKeyA]: Date.now(),
          [otherTabPaneKey]: Date.now()
        }
      })

      store.getState().closeUnifiedTab('dock-tab-1', { terminalRetirementHandled: true })

      const pending = store.getState().terminalDockPendingMutationsByPaneKey
      expect(pending[paneKeyA]).toBeUndefined()
      expect(pending[otherTabPaneKey]).toBeDefined()
    })
  })
})
