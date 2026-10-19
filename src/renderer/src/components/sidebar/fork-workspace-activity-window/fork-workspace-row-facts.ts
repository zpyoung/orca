import type { Repo } from '../../../../../shared/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { WorkspaceRowFactReader } from '../../../../../shared/workspace-view/workspace-row-filters'
import { createReviewFilterPredicate } from '../fork-workspace-review-filters/workspace-review-filter'
import type { WorkspaceReviewFilterContext } from '../fork-workspace-review-filters/workspace-review-filter'
import {
  createActivityFilterPredicate,
  isSelectedActivityWorkspace
} from './workspace-activity-filter'
import type { WorkspaceActivityFilterContext } from './workspace-activity-filter'

type ForkWorkspaceRowFactInputs = {
  repoMap: Map<string, Repo>
  workspaceActivity?: WorkspaceActivityFilterContext
  workspaceReview?: WorkspaceReviewFilterContext
}

/**
 * Folds the activity-window and review filters into the shared fact reader. Rows they drop read
 * as archived so they stay out of the list yet remain available as lineage ancestors, and the
 * open workspace under "Live only" is exempt from the sleeping sweep.
 */
export function withForkWorkspaceRowFacts(
  facts: WorkspaceRowFactReader<Worktree>,
  inputs: ForkWorkspaceRowFactInputs
): WorkspaceRowFactReader<Worktree> {
  const keepByActivity = createActivityFilterPredicate(inputs.workspaceActivity, inputs.repoMap)
  const keepByReview = createReviewFilterPredicate(inputs.workspaceReview, inputs.repoMap)
  const liveOnly = inputs.workspaceActivity?.workspaceActivityWindow === 'live-only'
  return {
    ...facts,
    isArchived: (worktree) =>
      facts.isArchived(worktree) ||
      (keepByActivity !== null && !keepByActivity(worktree)) ||
      (keepByReview !== null && !keepByReview(worktree)),
    isSleeping: (worktree) =>
      !(liveOnly && isSelectedActivityWorkspace(worktree, inputs.workspaceActivity)) &&
      facts.isSleeping(worktree)
  }
}
