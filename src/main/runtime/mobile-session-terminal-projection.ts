import type { RuntimeMobileSessionTerminalTab } from '../../shared/runtime-types'
import type { TerminalTab } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  cloneTerminalLayoutSnapshot,
  collectPersistedTerminalLeafIds,
  deriveHeadlessLegacyTerminalLeafId,
  isPersistedTerminalLeafActive
} from './mobile-session-layout-projection'
import type { TerminalDockPaneState } from '../../shared/fork-terminal-dock/terminal-dock-pane-state'

export function buildHeadlessMobileSessionTerminalTabs(
  worktreeId: string,
  persistedTabs: readonly TerminalTab[],
  session: WorkspaceSessionState
): RuntimeMobileSessionTerminalTab[] {
  // Why: the dock record lives only on the unified Tab, not the legacy
  // TerminalTab this hydration path otherwise rebuilds from.
  const terminalDockByPaneKeyByTabId = new Map<string, Record<string, TerminalDockPaneState>>()
  for (const unifiedTab of session.unifiedTabs?.[worktreeId] ?? []) {
    if (unifiedTab.terminalDockByPaneKey) {
      terminalDockByPaneKeyByTabId.set(unifiedTab.id, unifiedTab.terminalDockByPaneKey)
      terminalDockByPaneKeyByTabId.set(unifiedTab.entityId, unifiedTab.terminalDockByPaneKey)
    }
  }
  return [...persistedTabs]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
    .flatMap((tab, index) => {
      const layout = session.terminalLayoutsByTabId?.[tab.id]
      const leafIds = collectPersistedTerminalLeafIds(layout)
      if (leafIds.length === 0) {
        leafIds.push(deriveHeadlessLegacyTerminalLeafId(tab.id))
      }
      const terminalDockByPaneKey = terminalDockByPaneKeyByTabId.get(tab.id)
      return leafIds.flatMap((leafId) => {
        const ptyId = layout?.ptyIdsByLeafId?.[leafId] ?? (leafIds.length === 1 ? tab.ptyId : null)
        const title =
          tab.customTitle?.trim() ||
          tab.generatedTitle?.trim() ||
          tab.title?.trim() ||
          tab.defaultTitle?.trim() ||
          `Terminal ${index + 1}`
        return [
          {
            type: 'terminal' as const,
            id: `${tab.id}::${leafId}`,
            parentTabId: tab.id,
            leafId,
            title,
            ...(ptyId ? { ptyId } : {}),
            ...(tab.startupCwd ? { startupCwd: tab.startupCwd } : {}),
            ...(tab.launchAgent ? { launchAgent: tab.launchAgent } : {}),
            ...(layout ? { parentLayout: cloneTerminalLayoutSnapshot(layout) } : {}),
            ...(tab.color != null ? { color: tab.color } : {}),
            ...(tab.isPinned ? { isPinned: true } : {}),
            ...(tab.viewMode ? { viewMode: tab.viewMode } : {}),
            ...(terminalDockByPaneKey ? { terminalDockByPaneKey } : {}),
            isActive: isPersistedTerminalLeafActive(session, worktreeId, tab.id, leafId, layout)
          }
        ]
      })
    })
}
