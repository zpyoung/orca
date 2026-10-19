import { findPaneDockComposer } from '@/components/terminal-pane/fork-terminal-dock/dock-composer-focus-redirect'
import type { AppState } from '@/store/types'
import {
  syncRuntimeGraph,
  setTrailingGraphSyncScheduler
} from './sync-runtime-graph/graph-publication'
import { graphState, RUNTIME_GRAPH_SYNC_COALESCE_MS } from './sync-runtime-graph/graph-state'
import { subscribeMountedTerminalTabChanges } from './mounted-terminal-tab-registry'
import { measureTerminalGroupGridSizes } from './sync-runtime-graph/terminal-group-grid-sizes'
export function setRuntimeGraphStoreStateGetter(getter: (() => AppState) | null): void {
  graphState.getStoreState = getter
}

/** True while the target TerminalPane is mounted (lifecycle effect ran). */
export function hasRegisteredRuntimeTerminalTab(tabId: string, worktreeId?: string): boolean {
  return findRegisteredTerminalTab(tabId, worktreeId) !== null
}

export function registerRuntimeTerminalTab(tab: RegisteredTerminalTab): () => void {
  const key = registeredTerminalTabKey(tab.worktreeId, tab.tabId)
  graphState.registeredTabs.set(key, tab)
  graphState.tabRegisteredAt.set(key, Date.now())
  scheduleRuntimeGraphSync()
  return () => {
    // React can mount a replacement before the old effect cleans up.
    if (graphState.registeredTabs.get(key) !== tab) {
      return
    }
    graphState.registeredTabs.delete(key)
    graphState.tabRegisteredAt.delete(key)
    scheduleRuntimeGraphSync()
  }
}

export function focusRuntimeTerminalSurface(
  tabId: string,
  leafId?: string | null,
  worktreeId?: string
): boolean {
  const registered = findRegisteredTerminalTab(tabId, worktreeId)?.tab
  const manager = registered?.getManager()
  if (!manager) {
    return false
  }
  if (!leafId) {
    // The dock composer sits above the xterm and is the pane's real input surface, so it wins
    // before the chat-cover check below ever applies.
    const activeDockComposer = findPaneDockComposer(manager.getActivePane())
    if (activeDockComposer) {
      activeDockComposer.focus()
      return true
    }
    // Why: mirrors focus-terminal-tab-surface.ts's chat-view bail — the xterm is covered by the
    // chat portal, so focusing it pulls the caret out of the composer. `true` = handled because
    // `false` sends the caller to the DOM fallback.
    if (activePaneIsCoveredByNativeChat(manager)) {
      return true
    }
    const pane = manager.getActivePane()
    if (!pane) {
      return false
    }
    pane.terminal.focus()
    return !!pane.terminal.textarea && document.activeElement === pane.terminal.textarea
  }
  const resolution = resolveLeafIdForManager(tabId, leafId, manager)
  if (resolution.status !== 'resolved') {
    return false
  }
  const requestedPane = manager
    .getPanes()
    .find((candidate) => candidate.id === resolution.numericPaneId)
  // Activating a covered leaf lets its chat surface claim the composer without focusing the
  // xterm underneath it. Explicit leaf requests must still change the manager's active pane.
  // A dock composer takes focus here rather than through the manager, which would focus the
  // xterm underneath it instead.
  const dockComposer = findPaneDockComposer(requestedPane)
  manager.setActivePane(resolution.numericPaneId, {
    focus: dockComposer ? false : !paneIsCoveredByNativeChat(requestedPane)
  })
  dockComposer?.focus()
  scheduleRuntimeGraphSync()
  return true
}

export function setRuntimeGraphSyncEnabled(enabled: boolean): void {
  graphState.syncEnabled = enabled
  if (!enabled) {
    graphState.syncPendingAfterFlight = false
    clearScheduledRuntimeGraphSync()
    return
  }
  scheduleRuntimeGraphSync()
}

function clearScheduledRuntimeGraphSync(): void {
  if (graphState.syncTimer !== null) {
    clearTimeout(graphState.syncTimer)
    graphState.syncTimer = null
  }
  graphState.syncScheduled = false
}

export function scheduleRuntimeGraphSync(): void {
  if (!graphState.syncEnabled || graphState.syncScheduled) {
    return
  }
  if (graphState.syncInFlight) {
    graphState.syncPendingAfterFlight = true
    return
  }
  graphState.syncScheduled = true
  // Collapse separate title/status tasks into one frame-sized graph publication.
  graphState.syncTimer = setTimeout(() => {
    graphState.syncTimer = null
    graphState.syncScheduled = false
    void runRuntimeGraphSync()
  }, RUNTIME_GRAPH_SYNC_COALESCE_MS)
}

/** Republishes the graph only when the grid a new tab would get in some group changed. */
export function scheduleRuntimeGraphSyncIfGroupGridSizesChanged(): void {
  const state = graphState.getStoreState?.()
  if (!state) {
    return
  }
  const sizes = measureTerminalGroupGridSizes(state.settings?.terminalFontSize ?? 14)
  if (JSON.stringify(sizes ?? null) !== graphState.publishedTerminalGroupGridSizesKey) {
    scheduleRuntimeGraphSync()
  }
}

/** A tab group body resized (window, divider, sidebar): its group's grid may have changed. */
export function observeTabGroupBodyGridSize(body: HTMLElement): () => void {
  const observer = new ResizeObserver(scheduleRuntimeGraphSyncIfGroupGridSizesChanged)
  observer.observe(body)
  return () => observer.disconnect()
}

async function runRuntimeGraphSync(): Promise<void> {
  if (graphState.syncInFlight) {
    graphState.syncPendingAfterFlight = true
    return
  }
  graphState.syncInFlight = true
  try {
    await syncRuntimeGraph()
  } finally {
    graphState.syncInFlight = false
    if (graphState.syncPendingAfterFlight) {
      graphState.syncPendingAfterFlight = false
      scheduleRuntimeGraphSync()
    }
  }
}

setTrailingGraphSyncScheduler(scheduleRuntimeGraphSync)
subscribeMountedTerminalTabChanges(scheduleRuntimeGraphSync)
