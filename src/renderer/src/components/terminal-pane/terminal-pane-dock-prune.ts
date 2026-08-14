import type { Tab } from '../../../../shared/types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { getCachedUnifiedTerminalTabForWorktree } from './terminal-unified-tab-lookup'

/** Resolves which unified tab and pane key to prune from `terminalDockByPaneKey` when a pane
 *  retires — covers plain close, retire, and detach-to-a-new-tab alike, since in every case
 *  the closed pane's `sourceTabId:leafId` key stops describing anything under the source tab.
 *  Returns null when the flag is off — flag-off is the dock's kill switch, so a pane closing
 *  must not write to `terminalDockByPaneKey` even to clean up a stale pre-disable entry. */
export function resolveTerminalDockPruneTarget(args: {
  unifiedTabsByWorktree: Record<string, Tab[]>
  worktreeId: string
  tabId: string
  leafId: string
  experimentalTerminalDockEnabled: boolean
}): { unifiedTabId: string; paneKey: string } | null {
  if (!args.experimentalTerminalDockEnabled) {
    return null
  }
  const unifiedTab = getCachedUnifiedTerminalTabForWorktree(
    args.unifiedTabsByWorktree,
    args.worktreeId,
    args.tabId
  )
  if (!unifiedTab) {
    return null
  }
  return { unifiedTabId: unifiedTab.id, paneKey: makePaneKey(args.tabId, args.leafId) }
}
