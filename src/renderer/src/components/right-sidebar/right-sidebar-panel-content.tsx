import { Suspense } from 'react'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import type { ActiveRightSidebarTab } from '@/store/slices/editor'
import { isPluginPanelTabKey } from '../../../../shared/plugins/manifest/plugin-manifest'

const FileExplorer = lazy(() => import('./FileExplorer'))
const SourceControl = lazy(() => import('./SourceControl'))
const ChecksPanel = lazy(() => import('./ChecksPanel'))
const PortsPanel = lazy(() => import('./PortsPanel'))
const AiVaultSidebarPanel = lazy(() => import('./AiVaultSidebarPanel'))
const SessionInfoPanel = lazy(() => import('./fork-session-info/SessionInfoPanel'))
const AskQuestionsPanel = lazy(() => import('./fork-ask-question-tool/AskQuestionsPanel'))
const FolderWorkspaceWorktreesPanel = lazy(() => import('./FolderWorkspaceWorktreesPanel'))
const FolderWorkspacePrChecksPanel = lazy(() => import('./FolderWorkspacePrChecksPanel'))
const LedgerPanel = lazy(() => import('./LedgerPanel'))
const PluginPanel = lazy(() => import('./PluginPanel'))

type RightSidebarPanelContentProps = {
  effectiveTab: ActiveRightSidebarTab
  rightSidebarOpen: boolean
}

export function RightSidebarPanelContent({
  effectiveTab,
  rightSidebarOpen
}: RightSidebarPanelContentProps): React.JSX.Element {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      // `orca plugin shot` captures exactly this rect.
      data-plugin-panel-surface={isPluginPanelTabKey(effectiveTab) ? effectiveTab : undefined}
    >
      <Suspense fallback={null}>
        {effectiveTab === 'explorer' && <FileExplorer />}
        {effectiveTab === 'source-control' && <SourceControl />}
        {effectiveTab === 'checks' && <ChecksPanel />}
        {/* SSH forwarding needs raw ports.detect data absent from the workspace-scoped status popover. */}
        {effectiveTab === 'ports' && (
          <PortsPanel isVisible={rightSidebarOpen && effectiveTab === 'ports'} />
        )}
        {effectiveTab === 'vault' && <AiVaultSidebarPanel />}
        {effectiveTab === 'session-info' && <SessionInfoPanel />}
        {effectiveTab === 'ask' && <AskQuestionsPanel />}
        {effectiveTab === 'workspaces' && <FolderWorkspaceWorktreesPanel />}
        {effectiveTab === 'pr-checks' && (
          <FolderWorkspacePrChecksPanel
            isVisible={rightSidebarOpen && effectiveTab === 'pr-checks'}
          />
        )}
        {effectiveTab === 'ledger' && (
          <LedgerPanel isVisible={rightSidebarOpen && effectiveTab === 'ledger'} />
        )}
        {/* Remount on plugin changes so an old iframe cannot post through the next plugin's rebound bridge. */}
        {isPluginPanelTabKey(effectiveTab) && (
          <PluginPanel key={effectiveTab} tabKey={effectiveTab} />
        )}
      </Suspense>
    </div>
  )
}
