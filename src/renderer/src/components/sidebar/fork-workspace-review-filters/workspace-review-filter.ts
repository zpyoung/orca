import type { Repo } from '../../../../../shared/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import { getWorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'
import { getGitHubPRCacheKey } from '@/store/slices/github-cache-key'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review-cache-identity'
import type { AppState } from '@/store/types'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { resolveWorkspaceReview } from './workspace-review-resolution'

export type WorkspaceReviewFilterContext = {
  hideCompletedReviewWorkspaces: boolean
  hidePassingCheckWorkspaces: boolean
  prCache: AppState['prCache'] | null
  hostedReviewCache: AppState['hostedReviewCache'] | null
  // The only settings field the cache keys read, kept primitive so an unrelated settings write
  // cannot re-key the sidebar's visibility scan.
  activeRuntimeEnvironmentId: GlobalSettings['activeRuntimeEnvironmentId'] | null
}

function cacheEntries(worktree: Worktree, repo: Repo, context: WorkspaceReviewFilterContext) {
  const branch = getWorktreeGitIdentityDisplay(worktree)
  const branchName = branch?.kind === 'branch' ? branch.branchName : ''
  if (!branchName) {
    return undefined
  }
  const settings = { activeRuntimeEnvironmentId: context.activeRuntimeEnvironmentId }
  const hostedKey = getHostedReviewCacheKey(
    repo.path,
    branchName,
    settings,
    repo.id,
    repo.connectionId,
    repo.executionHostId,
    true
  )
  const prKey = getGitHubPRCacheKey(
    repo.path,
    repo.id,
    branchName,
    settings,
    repo.connectionId,
    repo.executionHostId,
    true
  )
  return {
    hostedReviewEntry: context.hostedReviewCache?.[hostedKey],
    prCacheEntry: context.prCache?.[prKey]
  }
}

export function filterWorktreesByReview(
  worktrees: Worktree[],
  context: WorkspaceReviewFilterContext | undefined,
  repoMap: Map<string, Repo>
): Worktree[] {
  if (!context || (!context.hideCompletedReviewWorkspaces && !context.hidePassingCheckWorkspaces)) {
    return worktrees
  }
  return worktrees.filter((worktree) => {
    const repo = repoMap.get(worktree.repoId)
    if (!repo) {
      return true
    }
    const entries = cacheEntries(worktree, repo, context)
    if (!entries) {
      return true
    }
    const { prDisplay, effectiveReviewStaleMerged } = resolveWorkspaceReview(
      worktree,
      entries.hostedReviewEntry,
      entries.prCacheEntry
    )
    if (!prDisplay || effectiveReviewStaleMerged) {
      return true
    }
    if (
      context.hideCompletedReviewWorkspaces &&
      (prDisplay.state === 'merged' || prDisplay.state === 'closed')
    ) {
      return false
    }
    if (context.hidePassingCheckWorkspaces && prDisplay.status === 'success') {
      return false
    }
    return true
  })
}
