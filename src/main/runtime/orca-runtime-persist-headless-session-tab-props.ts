// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithCloseHeadlessMobileTerminalTab } from './orca-runtime-close-headless-mobile-terminal-tab'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../shared/terminal-tab-types'
import { cloneTerminalLayoutSnapshot } from './mobile-session-layout-projection'
import { randomUUID } from 'node:crypto'
import type { Tab } from '../../shared/tab-types'
import {
  terminalDockPatchFragment,
  type TerminalDockPropsPatch
} from './fork-terminal-dock/terminal-dock-session-tab-props'

export class OrcaRuntimeWithPersistHeadlessSessionTabProps extends OrcaRuntimeWithCloseHeadlessMobileTerminalTab {
  protected persistHeadlessSessionTabProps(
    worktreeId: string,
    tabId: string,
    props: {
      color?: string | null
      isPinned?: boolean
      viewMode?: 'terminal' | 'chat'
      terminalDock?: TerminalDockPropsPatch
    }
  ): void {
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    if (!session || !this.store?.setWorkspaceSession) {
      return
    }
    const livePaneKeys = props.terminalDock
      ? this.getLiveTerminalDockPaneKeysForTab(tabId)
      : undefined
    const tabs = session.tabsByWorktree[worktreeId]
    const nextSession: WorkspaceSessionState = { ...session }
    let changed = false
    if (tabs?.some((tab) => tab.id === tabId)) {
      changed = true
      nextSession.tabsByWorktree = {
        ...session.tabsByWorktree,
        [worktreeId]: tabs.map((tab) =>
          tab.id === tabId
            ? {
                ...tab,
                ...(props.color !== undefined ? { color: props.color } : {}),
                ...(props.isPinned !== undefined ? { isPinned: props.isPinned } : {}),
                ...(props.viewMode !== undefined ? { viewMode: props.viewMode } : {})
              }
            : tab
        )
      }
    }

    const unifiedTabs = session.unifiedTabs?.[worktreeId]
    if (unifiedTabs?.some((tab) => tab.id === tabId || tab.entityId === tabId)) {
      changed = true
      nextSession.unifiedTabs = {
        ...session.unifiedTabs,
        [worktreeId]: unifiedTabs.map((tab) =>
          tab.id === tabId || tab.entityId === tabId
            ? {
                ...tab,
                ...(props.color !== undefined ? { color: props.color } : {}),
                ...(props.isPinned !== undefined ? { isPinned: props.isPinned } : {}),
                ...terminalDockPatchFragment(
                  tab.terminalDockByPaneKey,
                  props.terminalDock,
                  livePaneKeys
                )
              }
            : tab
        )
      }
    } else if (props.terminalDock) {
      // legacy sessions have no unified tab to carry the dock record — mint one
      // so the patch actually persists instead of acking a no-op.
      const legacyTab = tabs?.find((tab) => tab.id === tabId)
      const dockFragment = terminalDockPatchFragment(undefined, props.terminalDock, livePaneKeys)
      if (legacyTab && dockFragment.terminalDockByPaneKey) {
        changed = true
        const mintedTab: Tab = {
          id: legacyTab.id,
          entityId: legacyTab.id,
          groupId: randomUUID(),
          worktreeId,
          contentType: 'terminal',
          label: legacyTab.title,
          customLabel: legacyTab.customTitle,
          color: props.color !== undefined ? props.color : legacyTab.color,
          sortOrder: legacyTab.sortOrder,
          createdAt: legacyTab.createdAt,
          isPinned: props.isPinned !== undefined ? props.isPinned : legacyTab.isPinned,
          ...(props.viewMode !== undefined
            ? { viewMode: props.viewMode }
            : legacyTab.viewMode !== undefined
              ? { viewMode: legacyTab.viewMode }
              : {}),
          ...dockFragment
        }
        nextSession.unifiedTabs = {
          ...session.unifiedTabs,
          [worktreeId]: [...(unifiedTabs ?? []), mintedTab]
        }
      }
    }

    if (!changed) {
      return
    }
    this.setWorkspaceSessionForWorktree(worktreeId, nextSession)
  }

  protected applyHeadlessSessionTabPropsToSnapshot(
    worktreeId: string,
    tabId: string,
    props: {
      color?: string | null
      isPinned?: boolean
      viewMode?: 'terminal' | 'chat'
      terminalDock?: TerminalDockPropsPatch
    }
  ): void {
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
      return
    }
    const livePaneKeys = props.terminalDock
      ? this.getLiveTerminalDockPaneKeysForTab(tabId)
      : undefined
    let changed = false
    const tabs = snapshot.tabs.map((tab) => {
      if (this.getMobileSessionTopLevelTabId(tab) !== tabId) {
        return tab
      }
      changed = true
      return {
        ...tab,
        ...(props.color !== undefined ? { color: props.color } : {}),
        ...(props.isPinned !== undefined ? { isPinned: props.isPinned } : {}),
        ...(props.viewMode !== undefined ? { viewMode: props.viewMode } : {}),
        ...(tab.type === 'terminal'
          ? terminalDockPatchFragment(tab.terminalDockByPaneKey, props.terminalDock, livePaneKeys)
          : {})
      }
    })
    if (!changed) {
      return
    }
    const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      publicationEpoch: `headless:${Date.now().toString(36)}`,
      snapshotVersion: snapshot.snapshotVersion + 1,
      tabs
    }
    this.storeMobileSessionSnapshot(worktreeId, nextSnapshot)
    this.emitMobileSessionTabsSnapshot(nextSnapshot)
  }

  // Why: the host's own PTY registry (ptysById) is the one source of "panes
  // this tab actually has" that a remote client can't forge — it's populated
  // from spawn-time bindings, not RPC input, and keeps a disconnected/
  // reconnecting pane's paneKey until the PTY is actually torn down.
  protected getLiveTerminalDockPaneKeysForTab(tabId: string): Set<string> {
    const liveKeys = new Set<string>()
    for (const pty of this.ptysById.values()) {
      if (pty.tabId === tabId && pty.paneKey) {
        liveKeys.add(pty.paneKey)
      }
    }
    return liveKeys
  }

  protected getMobileSessionTopLevelTabId(tab: RuntimeMobileSessionSnapshotTab): string {
    return tab.type === 'terminal' ? tab.parentTabId : tab.id
  }

  // Merge the client's pane structure into the persisted tab layout. PTY
  // bindings and active leaf stay host-owned; only ratios/expand/titles change.
  // terminalLayoutsByTabId is keyed by tab id (worktree-independent).
  protected persistHeadlessTerminalPaneLayout(
    worktreeId: string,
    args: {
      tabId: string
      root: TerminalPaneLayoutNode | null
      expandedLeafId: string | null
      titlesByLeafId?: Record<string, string>
    }
  ): TerminalLayoutSnapshot | undefined {
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    if (!session || !this.store?.setWorkspaceSession) {
      return undefined
    }
    const existing = session.terminalLayoutsByTabId?.[args.tabId]
    if (!existing) {
      return undefined
    }
    const candidate = {
      ...session,
      terminalLayoutsByTabId: {
        ...session.terminalLayoutsByTabId,
        [args.tabId]: {
          ...cloneTerminalLayoutSnapshot(existing),
          root: args.root ?? existing.root,
          expandedLeafId: args.expandedLeafId,
          ...(args.titlesByLeafId ? { titlesByLeafId: args.titlesByLeafId } : {})
        }
      }
    }
    this.setWorkspaceSessionForWorktree(worktreeId, candidate)
    // Why: persistence may reject stale membership while accepting its metadata; publish only that rebased layout.
    return (
      this.getWorkspaceSessionForWorktree(worktreeId)?.terminalLayoutsByTabId[args.tabId] ??
      candidate.terminalLayoutsByTabId[args.tabId]
    )
  }

  protected applyHeadlessTerminalPaneLayoutToSnapshot(
    worktreeId: string,
    args: {
      tabId: string
      root: TerminalPaneLayoutNode | null
      expandedLeafId: string | null
      titlesByLeafId?: Record<string, string>
    }
  ): void {
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
      return
    }
    let changed = false
    const tabs = snapshot.tabs.map((tab) => {
      if (tab.type !== 'terminal' || tab.parentTabId !== args.tabId || !tab.parentLayout) {
        return tab
      }
      changed = true
      return {
        ...tab,
        parentLayout: {
          ...tab.parentLayout,
          root: args.root ?? tab.parentLayout.root,
          expandedLeafId: args.expandedLeafId,
          ...(args.titlesByLeafId ? { titlesByLeafId: args.titlesByLeafId } : {})
        }
      }
    })
    if (!changed) {
      return
    }
    const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      publicationEpoch: `headless:${Date.now().toString(36)}`,
      snapshotVersion: snapshot.snapshotVersion + 1,
      tabs
    }
    this.storeMobileSessionSnapshot(worktreeId, nextSnapshot)
    this.emitMobileSessionTabsSnapshot(nextSnapshot)
  }
}
