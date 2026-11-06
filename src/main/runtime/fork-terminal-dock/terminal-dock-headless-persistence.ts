import { randomUUID } from 'node:crypto'
import type { Tab } from '../../../shared/tab-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import {
  terminalDockPatchFragment,
  type TerminalDockPropsPatch
} from './terminal-dock-session-tab-props'

/** The paneKeys the host's own PTY registry binds to `tabId`. Populated from
 *  spawn-time bindings rather than RPC input, so a remote client can't forge
 *  one; a disconnected pane keeps its key until the PTY is actually torn down. */
export function liveTerminalDockPaneKeysForTab(
  ptys: Iterable<{ tabId?: string | null; paneKey?: string | null }>,
  tabId: string
): Set<string> {
  const liveKeys = new Set<string>()
  for (const pty of ptys) {
    if (pty.tabId === tabId && pty.paneKey) {
      liveKeys.add(pty.paneKey)
    }
  }
  return liveKeys
}

/** Legacy sessions have no unified tab to carry the dock record, so mint one
 *  from the saved terminal tab; otherwise the patch would ack as a no-op.
 *  Returns the worktree's unified tabs with the minted one appended, or
 *  undefined when there is nothing to mint. */
export function mintUnifiedTabsForTerminalDock(args: {
  legacyTab: TerminalTab | undefined
  unifiedTabs: readonly Tab[] | undefined
  worktreeId: string
  props: { color?: string | null; isPinned?: boolean; viewMode?: 'terminal' | 'chat' }
  dockPatch: TerminalDockPropsPatch | undefined
  livePaneKeys: ReadonlySet<string> | undefined
}): Tab[] | undefined {
  const { legacyTab, worktreeId, props } = args
  const terminalDockByPaneKey = args.dockPatch
    ? terminalDockPatchFragment(undefined, args.dockPatch, args.livePaneKeys).terminalDockByPaneKey
    : undefined
  if (!legacyTab || !terminalDockByPaneKey) {
    return undefined
  }
  const minted: Tab = {
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
    terminalDockByPaneKey
  }
  return [...(args.unifiedTabs ?? []), minted]
}
