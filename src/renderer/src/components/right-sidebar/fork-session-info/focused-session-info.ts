import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { useShallow } from 'zustand/react/shallow'
import type { AgentStatusEntry } from '../../../../../shared/agent-status-types'
import { isTerminalLeafId, makePaneKey } from '../../../../../shared/stable-pane-id'
import { parseWorkspaceKey } from '../../../../../shared/workspace-scope'
import { resolvePaneWslDistro } from '../../terminal-pane/terminal-pane-wsl-distro'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'

export type FocusedSessionSelection = {
  tabId: string | null
  leafId: string | null
  paneKey: string | null
  status: AgentStatusEntry | null
  paneLabel: string | null
  workspaceLabel: string | null
  workspaceRoot: string | null
  connectionId: string | undefined
  activeRuntimeEnvironmentId: string | null
  wslDistro: string | null
  isLocalExecution: boolean
}

type FocusedSessionState = Pick<
  AppState,
  | 'activeRepoId'
  | 'activeTabId'
  | 'activeTabType'
  | 'activeWorkspaceExecutionHostId'
  | 'activeWorktreeId'
  | 'agentStatusByPaneKey'
  | 'detectedWorktreesByRepo'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'projects'
  | 'removedRuntimeEnvironmentIds'
  | 'repos'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
  | 'runtimeEnvironmentCatalogHydrated'
  | 'runtimeEnvironments'
  | 'settings'
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'worktreesByRepo'
  | 'getKnownWorktreeById'
>

export function resolveFocusedSession(state: FocusedSessionState): FocusedSessionSelection {
  const activeTabBelongsToWorkspace = Boolean(
    state.activeWorktreeId &&
    state.activeTabId &&
    state.tabsByWorktree[state.activeWorktreeId]?.some((tab) => tab.id === state.activeTabId)
  )
  const tabId =
    state.activeTabType === 'terminal' && activeTabBelongsToWorkspace ? state.activeTabId : null
  const layout = tabId ? state.terminalLayoutsByTabId[tabId] : undefined
  const leafId = layout?.activeLeafId ?? null
  const paneKey = tabId && leafId && isTerminalLeafId(leafId) ? makePaneKey(tabId, leafId) : null
  const status = paneKey ? (state.agentStatusByPaneKey[paneKey] ?? null) : null
  const workspaceScope = parseWorkspaceKey(state.activeWorktreeId ?? '')
  const folderWorkspace =
    workspaceScope?.type === 'folder'
      ? state.folderWorkspaces.find(
          (workspace) => workspace.id === workspaceScope.folderWorkspaceId
        )
      : undefined
  const worktree =
    !folderWorkspace && state.activeWorktreeId
      ? (state.getKnownWorktreeById(state.activeWorktreeId) ?? undefined)
      : undefined
  const connectionId = status?.connectionId ?? folderWorkspace?.connectionId ?? undefined
  const activeRuntimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(
    state,
    state.activeWorktreeId
  )
  const workspaceRoot = folderWorkspace?.folderPath ?? worktree?.path ?? null
  const wslDistro =
    state.activeWorktreeId && workspaceRoot
      ? resolvePaneWslDistro(state, state.activeWorktreeId, workspaceRoot)
      : null

  return {
    tabId,
    leafId: paneKey ? leafId : null,
    paneKey,
    status,
    paneLabel: leafId ? (layout?.titlesByLeafId?.[leafId] ?? status?.terminalTitle ?? null) : null,
    workspaceLabel: folderWorkspace?.name ?? worktree?.displayName ?? null,
    workspaceRoot,
    connectionId,
    activeRuntimeEnvironmentId,
    wslDistro,
    isLocalExecution: !connectionId && !activeRuntimeEnvironmentId && !wslDistro
  }
}

export function getFocusedSessionBindingKey(
  paneKey: string | null,
  status: AgentStatusEntry | null
): string {
  if (!paneKey || !status) {
    return 'none'
  }
  const providerSessionId = status.providerSession?.id
  const firstObservedAt = Math.min(
    status.stateStartedAt,
    ...status.stateHistory.map((entry) => entry.startedAt)
  )
  return `${paneKey}:${providerSessionId ?? `${status.agentType ?? 'agent'}:${firstObservedAt}`}`
}

export function useFocusedSession(): FocusedSessionSelection {
  return useAppStore(useShallow(resolveFocusedSession))
}
