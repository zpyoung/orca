export type WorkspaceReviewFilterState = {
  hideCompletedReviewWorkspaces: boolean
  hidePassingCheckWorkspaces: boolean
}

export type PersistedWorkspaceReviewFilterState = {
  hideCompletedReviewWorkspaces?: boolean
  hidePassingCheckWorkspaces?: boolean
}

export const DEFAULT_HIDE_COMPLETED_REVIEW_WORKSPACES = false
export const DEFAULT_HIDE_PASSING_CHECK_WORKSPACES = false

export const DEFAULT_WORKSPACE_REVIEW_FILTER_STATE: WorkspaceReviewFilterState = {
  hideCompletedReviewWorkspaces: DEFAULT_HIDE_COMPLETED_REVIEW_WORKSPACES,
  hidePassingCheckWorkspaces: DEFAULT_HIDE_PASSING_CHECK_WORKSPACES
}
export const WORKSPACE_REVIEW_FILTER_WRITE_BASELINE_SAMPLE = {
  hideCompletedReviewWorkspaces: DEFAULT_HIDE_COMPLETED_REVIEW_WORKSPACES,
  hidePassingCheckWorkspaces: DEFAULT_HIDE_PASSING_CHECK_WORKSPACES
}

export function hydrateWorkspaceReviewFilters(
  ui: Pick<
    PersistedWorkspaceReviewFilterState,
    'hideCompletedReviewWorkspaces' | 'hidePassingCheckWorkspaces'
  >
): WorkspaceReviewFilterState {
  return {
    hideCompletedReviewWorkspaces: ui.hideCompletedReviewWorkspaces === true,
    hidePassingCheckWorkspaces: ui.hidePassingCheckWorkspaces === true
  }
}
