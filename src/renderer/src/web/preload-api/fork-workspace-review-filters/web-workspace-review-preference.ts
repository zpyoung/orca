import type { PersistedUIState } from '../../../../../shared/persisted-ui-state-types'
import { hydrateWorkspaceReviewFilters } from '../../../../../shared/fork-workspace-review-filters/workspace-review-filters'

export function normalizeWebWorkspaceReviewFilters(
  base: PersistedUIState,
  updates: Partial<PersistedUIState>
) {
  return hydrateWorkspaceReviewFilters({
    hideCompletedReviewWorkspaces:
      updates.hideCompletedReviewWorkspaces ?? base.hideCompletedReviewWorkspaces,
    hidePassingCheckWorkspaces:
      updates.hidePassingCheckWorkspaces ?? base.hidePassingCheckWorkspaces
  })
}
