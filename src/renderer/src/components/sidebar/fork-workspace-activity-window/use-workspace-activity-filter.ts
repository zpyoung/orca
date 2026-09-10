import { useAppStore } from '@/store'
import { getActiveSidebarWorkspaceId } from '../../../../../shared/workspace-scope'
import type { AppState } from '@/store/types'
import type { WorkspaceActivityFilterContext } from './workspace-activity-filter'
import { hydrateWorkspaceActivityWindow } from '../../../../../shared/fork-workspace-activity-window/workspace-activity-window'

export type { WorkspaceActivityFilterContext } from './workspace-activity-filter'

type ActivitySelectorInputs = Pick<
  AppState,
  | 'workspaceActivityWindow'
  | 'workspaceActivityCustomDays'
  | 'lastVisitedAtByWorktreeId'
  | 'workspaceActivityExitStamps'
  | 'activeWorkspaceKey'
  | 'activeWorktreeId'
  | 'activeWorkspaceExecutionHostId'
  | 'worktreesByRepo'
  | 'folderWorkspaces'
  | 'repos'
>

let previousInputs: ActivitySelectorInputs | undefined
let previousContext: WorkspaceActivityFilterContext | undefined

export function getWorkspaceActivityFilterContext(state: AppState): WorkspaceActivityFilterContext {
  const inputs = previousInputs
  if (
    inputs &&
    previousContext &&
    inputs.workspaceActivityWindow === state.workspaceActivityWindow &&
    inputs.workspaceActivityCustomDays === state.workspaceActivityCustomDays &&
    inputs.lastVisitedAtByWorktreeId === state.lastVisitedAtByWorktreeId &&
    inputs.workspaceActivityExitStamps === state.workspaceActivityExitStamps &&
    inputs.activeWorkspaceKey === state.activeWorkspaceKey &&
    inputs.activeWorktreeId === state.activeWorktreeId &&
    inputs.activeWorkspaceExecutionHostId === state.activeWorkspaceExecutionHostId &&
    inputs.worktreesByRepo === state.worktreesByRepo &&
    inputs.folderWorkspaces === state.folderWorkspaces &&
    inputs.repos === state.repos
  ) {
    return previousContext
  }
  const hydrated = hydrateWorkspaceActivityWindow(state)
  previousInputs = {
    workspaceActivityWindow: state.workspaceActivityWindow,
    workspaceActivityCustomDays: state.workspaceActivityCustomDays,
    lastVisitedAtByWorktreeId: state.lastVisitedAtByWorktreeId,
    workspaceActivityExitStamps: state.workspaceActivityExitStamps,
    activeWorkspaceKey: state.activeWorkspaceKey,
    activeWorktreeId: state.activeWorktreeId,
    activeWorkspaceExecutionHostId: state.activeWorkspaceExecutionHostId,
    worktreesByRepo: state.worktreesByRepo,
    folderWorkspaces: state.folderWorkspaces,
    repos: state.repos
  }
  previousContext = {
    workspaceActivityWindow: hydrated.workspaceActivityWindow,
    workspaceActivityCustomDays: hydrated.workspaceActivityCustomDays,
    lastVisitedAtByWorktreeId: state.lastVisitedAtByWorktreeId,
    workspaceActivityExitStamps: state.workspaceActivityExitStamps,
    selectedWorkspaceId: getActiveSidebarWorkspaceId(
      state.activeWorkspaceKey,
      state.activeWorktreeId
    ),
    selectedHostId: state.activeWorkspaceExecutionHostId ?? null,
    now: Date.now()
  }
  return previousContext
}

export function useWorkspaceActivityFilter(): WorkspaceActivityFilterContext {
  return useAppStore(getWorkspaceActivityFilterContext)
}
