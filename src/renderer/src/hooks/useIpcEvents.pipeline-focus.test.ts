import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as ReactModule from 'react'

type FocusEditorTabEvent = { tabId: string; worktreeId: string }

/** Subscription no-ops for every listener useIpcEvents attaches beyond onFocusEditorTab. */
function createApiNamespaceStub(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return new Proxy(overrides, {
    get: (target, prop: string) => (prop in target ? target[prop] : () => () => {})
  })
}

/**
 * Prepares a stubbed preload API for useIpcEvents, capturing only the
 * onFocusEditorTab listener so its dispatch behavior can be driven directly —
 * mirrors ipc-events-test-harness.ts's approach for the create-terminal listener.
 * Returns the (uninvoked) hook itself: call it inside the test body, same as
 * ipc-events-test-harness.ts's own doc comment requires.
 */
async function setupFocusEditorTabHarness(storeState: Record<string, unknown>): Promise<{
  useIpcEvents: () => void
  fireFocusEditorTab: (event: FocusEditorTabEvent) => void
}> {
  let listener: ((event: FocusEditorTabEvent) => void) | null = null

  vi.resetModules()
  vi.unstubAllGlobals()

  vi.doMock('react', async () => {
    const actual = await vi.importActual<typeof ReactModule>('react')
    return { ...actual, useEffect: (effect: () => void | (() => void)) => void effect() }
  })
  vi.doMock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))
  vi.doMock('../store', () => ({
    useAppStore: { subscribe: vi.fn(() => () => {}), getState: () => storeState }
  }))
  vi.doMock('@/lib/ui-zoom', () => ({ applyUIZoom: vi.fn() }))
  vi.doMock('@/lib/worktree-activation', () => ({
    activateAndRevealWorktree: vi.fn(),
    activateAndRevealWorkspace: vi.fn(),
    ensureWorktreeHasInitialTerminal: vi.fn()
  }))
  vi.doMock('@/components/sidebar/visible-worktrees', () => ({
    getVisibleWorktreeIds: () => []
  }))
  vi.doMock('@/lib/floating-workspace-terminal-actions', () => ({
    createFloatingWorkspaceTerminalTab: vi.fn(),
    isEmptyFloatingWorkspacePanelVisible: () => false,
    isFloatingWorkspacePanelFocused: () => false
  }))
  vi.doMock('@/runtime/web-runtime-session', () => ({
    activateWebRuntimeSessionTab: vi.fn(),
    closeWebRuntimeSessionTab: vi.fn(),
    createWebRuntimeSessionBrowserTab: vi.fn().mockResolvedValue(false),
    createWebRuntimeSessionTerminal: vi.fn().mockResolvedValue({ status: 'failed', message: '' }),
    isWebRuntimeSessionActive: vi.fn(() => false)
  }))
  vi.doMock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))
  vi.doMock('@/runtime/sync-runtime-graph', () => ({
    focusRuntimeTerminalSurface: vi.fn(() => false),
    hasRegisteredRuntimeTerminalTab: vi.fn(() => false)
  }))
  vi.doMock('@/lib/activate-tab-and-focus-pane', () => ({ activateTabAndFocusPane: vi.fn() }))

  vi.stubGlobal('window', {
    dispatchEvent: vi.fn(),
    api: new Proxy(
      {
        ui: createApiNamespaceStub({
          getZoomLevel: () => 0,
          consumePendingOpenSettings: () => Promise.resolve(false),
          set: vi.fn(),
          onFocusEditorTab: (fn: (event: FocusEditorTabEvent) => void) => {
            listener = fn
            return () => {}
          }
        }),
        rateLimits: {
          get: () => Promise.resolve({ limits: {}, lastUpdatedAt: 0 }),
          onUpdate: () => () => {}
        },
        runtime: {
          getTerminalFitOverrides: () => Promise.resolve([]),
          getTerminalDrivers: () => Promise.resolve([]),
          getBrowserDrivers: () => Promise.resolve([]),
          onTerminalFitOverrideChanged: () => () => {},
          onTerminalDriverChanged: () => () => {},
          onBrowserDriverChanged: () => () => {}
        },
        ssh: {
          listTargets: () => Promise.resolve([]),
          listPortForwards: () => Promise.resolve([]),
          listDetectedPorts: () => Promise.resolve([]),
          listRemovedTargetLabels: () => Promise.resolve([]),
          getState: () => Promise.resolve(null),
          onStateChanged: () => () => {},
          onCredentialRequest: () => () => {},
          onCredentialResolved: () => () => {},
          onPortForwardsChanged: () => () => {},
          onDetectedPortsChanged: () => () => {}
        },
        updater: {
          getStatus: () => Promise.resolve({ state: 'idle' }),
          onStatus: () => () => {},
          onClearDismissal: () => () => {}
        },
        mobile: createApiNamespaceStub({
          consumePendingUnpairedDeviceAuthFailure: () => Promise.resolve(false)
        }),
        remoteWorkspace: createApiNamespaceStub({ clientId: () => Promise.resolve(null) })
      } as Record<string, unknown>,
      { get: (target, prop: string) => target[prop] ?? createApiNamespaceStub() }
    )
  })

  const { useIpcEvents } = await import('./useIpcEvents')

  return {
    useIpcEvents,
    fireFocusEditorTab: (event) => {
      if (typeof listener !== 'function') {
        throw new Error('Expected the focus-editor-tab listener to be registered')
      }
      listener(event)
    }
  }
}

function makeStoreState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    unifiedTabsByWorktree: {},
    browserTabsByWorktree: {},
    setActiveWorktree: vi.fn(),
    markWorktreeVisited: vi.fn(),
    setActiveView: vi.fn(),
    focusGroup: vi.fn(),
    activateTab: vi.fn(),
    setActiveBrowserTab: vi.fn(),
    setActiveTabType: vi.fn(),
    setActiveFile: vi.fn(),
    revealWorktreeInSidebar: vi.fn(),
    // Why: useIpcEvents wires update-status/rate-limit subscriptions on mount
    // regardless of which listener a test drives; stub them to avoid noisy
    // unhandled rejections from unrelated effects.
    setUpdateStatus: vi.fn(),
    setRateLimitsFromPush: vi.fn(),
    ...overrides
  }
}

describe('useIpcEvents onFocusEditorTab', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('react')
  })

  it('never writes a pipeline run id into setActiveFile under activeTabType "editor"', async () => {
    const storeState = makeStoreState({
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'unified-run_abc',
            entityId: 'run_abc',
            groupId: 'group-1',
            worktreeId: 'wt-1',
            contentType: 'pipeline',
            label: 'bugfix-fast #1',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      }
    })
    const { useIpcEvents, fireFocusEditorTab } = await setupFocusEditorTabHarness(storeState)
    useIpcEvents()
    await Promise.resolve()

    fireFocusEditorTab({ tabId: 'unified-run_abc', worktreeId: 'wt-1' })

    expect(storeState.setActiveFile).not.toHaveBeenCalled()
    expect(storeState.setActiveTabType).not.toHaveBeenCalledWith('editor')
    expect(storeState.activateTab).toHaveBeenCalledWith('unified-run_abc')
  })

  it('still routes a real editor tab through setActiveFile + activeTabType "editor"', async () => {
    const storeState = makeStoreState({
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'unified-file',
            entityId: '/tmp/feature/src/main.ts',
            groupId: 'group-1',
            worktreeId: 'wt-1',
            contentType: 'editor',
            label: 'main.ts',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      }
    })
    const { useIpcEvents, fireFocusEditorTab } = await setupFocusEditorTabHarness(storeState)
    useIpcEvents()
    await Promise.resolve()

    fireFocusEditorTab({ tabId: 'unified-file', worktreeId: 'wt-1' })

    expect(storeState.setActiveFile).toHaveBeenCalledWith('/tmp/feature/src/main.ts')
    expect(storeState.setActiveTabType).toHaveBeenCalledWith('editor')
  })
})
