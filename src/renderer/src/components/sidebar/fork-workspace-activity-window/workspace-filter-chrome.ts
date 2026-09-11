import type { WorkspaceActivityWindow } from '../../../../../shared/fork-workspace-activity-window/workspace-activity-window'

export type ForkFilterChromeState = {
  workspaceActivityWindow?: WorkspaceActivityWindow
  workspaceActivityCustomDays?: number
  hideCompletedReviewWorkspaces?: boolean
  hidePassingCheckWorkspaces?: boolean
  showSleepingWorkspaces?: boolean
}

export function hasActivityFilter(state: ForkFilterChromeState): boolean {
  return state.workspaceActivityWindow != null
    ? state.workspaceActivityWindow !== 'all'
    : state.showSleepingWorkspaces === false
}

export function getForkFilterCount(state: ForkFilterChromeState): number {
  return (
    (hasActivityFilter(state) ? 1 : 0) +
    (state.hideCompletedReviewWorkspaces === true ? 1 : 0) +
    (state.hidePassingCheckWorkspaces === true ? 1 : 0)
  )
}

export type ForkClearFilterActions = {
  resetWorkspaceActivityWindow: boolean
  resetHideCompletedReviewWorkspaces: boolean
  resetHidePassingCheckWorkspaces: boolean
}

export function getForkClearFilterActions(state: ForkFilterChromeState): ForkClearFilterActions {
  return {
    resetWorkspaceActivityWindow:
      state.workspaceActivityWindow != null && state.workspaceActivityWindow !== 'all',
    resetHideCompletedReviewWorkspaces: state.hideCompletedReviewWorkspaces === true,
    resetHidePassingCheckWorkspaces: state.hidePassingCheckWorkspaces === true
  }
}
