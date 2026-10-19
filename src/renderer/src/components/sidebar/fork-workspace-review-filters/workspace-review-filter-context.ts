import type { AppState } from '@/store/types'
import type { WorkspaceReviewFilterContext } from './workspace-review-filter'

/** Store-free so store slices can reach it without an import cycle through `@/store`. */
export function getWorkspaceReviewFilterContext(state: AppState): WorkspaceReviewFilterContext {
  const hideCompletedReviewWorkspaces = state.hideCompletedReviewWorkspaces
  const hidePassingCheckWorkspaces = state.hidePassingCheckWorkspaces
  const active = hideCompletedReviewWorkspaces || hidePassingCheckWorkspaces
  return {
    hideCompletedReviewWorkspaces,
    hidePassingCheckWorkspaces,
    prCache: active ? state.prCache : null,
    hostedReviewCache: active ? state.hostedReviewCache : null
  }
}
