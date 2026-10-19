import type { WorkspaceActivityWindow } from '../../../../../shared/fork-workspace-activity-window/workspace-activity-window'
import type { AppState } from '@/store/types'

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

/** Counts the fork's filters except "Live only", which the shared hide-sleeping filter already counts. */
export function getForkOnlyFilterCount(state: ForkFilterChromeState): number {
  const timeWindowActive =
    state.workspaceActivityWindow != null &&
    state.workspaceActivityWindow !== 'all' &&
    state.workspaceActivityWindow !== 'live-only'
  return (
    (timeWindowActive ? 1 : 0) +
    (state.hideCompletedReviewWorkspaces === true ? 1 : 0) +
    (state.hidePassingCheckWorkspaces === true ? 1 : 0)
  )
}

export function selectForkFilterChromeState(
  state: AppState
): Pick<
  AppState,
  | 'workspaceActivityWindow'
  | 'workspaceActivityCustomDays'
  | 'hideCompletedReviewWorkspaces'
  | 'hidePassingCheckWorkspaces'
> {
  return {
    workspaceActivityWindow: state.workspaceActivityWindow,
    workspaceActivityCustomDays: state.workspaceActivityCustomDays,
    hideCompletedReviewWorkspaces: state.hideCompletedReviewWorkspaces,
    hidePassingCheckWorkspaces: state.hidePassingCheckWorkspaces
  }
}

export type ForkFilterSetters = Pick<
  AppState,
  | 'setWorkspaceActivityWindow'
  | 'setHideCompletedReviewWorkspaces'
  | 'setHidePassingCheckWorkspaces'
>

/** Resets the fork's filters; a store missing a setter belongs to a surface that never sets it. */
export function clearForkFilters(
  state: ForkFilterChromeState,
  store: Partial<ForkFilterSetters>
): void {
  const actions = getForkClearFilterActions(state)
  if (actions.resetWorkspaceActivityWindow) {
    store.setWorkspaceActivityWindow?.('all')
  }
  if (actions.resetHideCompletedReviewWorkspaces) {
    store.setHideCompletedReviewWorkspaces?.(false)
  }
  if (actions.resetHidePassingCheckWorkspaces) {
    store.setHidePassingCheckWorkspaces?.(false)
  }
}
