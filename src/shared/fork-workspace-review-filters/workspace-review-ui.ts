import { hydrateWorkspaceReviewFilters } from './workspace-review-filters'

export type WorkspaceReviewUIInput = {
  hideCompletedReviewWorkspaces?: unknown
  hidePassingCheckWorkspaces?: unknown
}

export function normalizeWorkspaceReviewUI(input: WorkspaceReviewUIInput | null | undefined): {
  hideCompletedReviewWorkspaces: boolean
  hidePassingCheckWorkspaces: boolean
} {
  return hydrateWorkspaceReviewFilters({
    hideCompletedReviewWorkspaces: input?.hideCompletedReviewWorkspaces === true,
    hidePassingCheckWorkspaces: input?.hidePassingCheckWorkspaces === true
  })
}

export function mergeWorkspaceReviewUI(
  current: WorkspaceReviewUIInput | null | undefined,
  updates: WorkspaceReviewUIInput
): {
  hideCompletedReviewWorkspaces: boolean
  hidePassingCheckWorkspaces: boolean
} {
  return normalizeWorkspaceReviewUI({
    hideCompletedReviewWorkspaces:
      updates.hideCompletedReviewWorkspaces ?? current?.hideCompletedReviewWorkspaces,
    hidePassingCheckWorkspaces:
      updates.hidePassingCheckWorkspaces ?? current?.hidePassingCheckWorkspaces
  })
}
