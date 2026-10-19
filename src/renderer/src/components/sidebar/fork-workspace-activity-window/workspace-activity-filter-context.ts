import { getActiveSidebarWorkspaceId } from '../../../../../shared/workspace-scope'
import type { AppState } from '@/store/types'
import type { WorkspaceActivityFilterContext } from './workspace-activity-filter'
import { hydrateWorkspaceActivityWindow } from '../../../../../shared/fork-workspace-activity-window/workspace-activity-window'

export type WorkspaceActivityFilterInputs = Omit<WorkspaceActivityFilterContext, 'now'>

export function selectWorkspaceActivityFilterInputs(
  state: AppState
): WorkspaceActivityFilterInputs {
  const hydrated = hydrateWorkspaceActivityWindow(state)
  return {
    workspaceActivityWindow: hydrated.workspaceActivityWindow,
    workspaceActivityCustomDays: hydrated.workspaceActivityCustomDays,
    lastVisitedAtByWorktreeId: state.lastVisitedAtByWorktreeId,
    workspaceActivityExitStamps: state.workspaceActivityExitStamps,
    selectedWorkspaceId: getActiveSidebarWorkspaceId(
      state.activeWorkspaceKey,
      state.activeWorktreeId
    ),
    selectedHostId: state.activeWorkspaceExecutionHostId ?? null
  }
}

/**
 * Pure snapshot for non-hook callers; every call reads the clock and the given state afresh.
 * Kept free of `@/store` so store slices can reach it without an import cycle.
 */
export function getWorkspaceActivityFilterContext(state: AppState): WorkspaceActivityFilterContext {
  return { ...selectWorkspaceActivityFilterInputs(state), now: Date.now() }
}
