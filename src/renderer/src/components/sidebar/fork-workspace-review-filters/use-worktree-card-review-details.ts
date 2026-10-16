// FORK-COPY-OF: src/renderer/src/components/sidebar/use-worktree-card-review-details.ts
// FORK-COPY-SHA: f51e82c4c26745f6a15e215e4391f533327697e2
import { useMemo } from 'react'
import { getLinearReadScope, scopedLinearCacheKey } from '@/store/slices/linear/linear-slice-scope'
import { getWorkspaceAttachmentSourceContext } from '../workspace-attachment-source-result'
import { getWorkspaceReferenceLinearWorkspaceId } from '../workspace-reference-details'
import { getWorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'
import { useAppStore } from '@/store'
import { getGitHubPRCacheKey } from '@/store/slices/github-cache-key'
import { issueCacheKey as getIssueCacheKey } from '@/store/github/cache-identity'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review-cache-identity'
import { isFolderRepo } from '../../../../../shared/repo-kind'
import { parseWorkspaceKey } from '../../../../../shared/workspace-scope'
import type { WorktreeCardProps } from '../worktree-card-model'
import type { useWorktreeCardFoundation } from '../use-worktree-card-foundation'
import { resolveWorkspaceReview } from './workspace-review-resolution'

type Foundation = ReturnType<typeof useWorktreeCardFoundation>

export function useWorktreeCardReviewDetails({
  worktree,
  repo,
  settings,
  projectGroups,
  cardProps,
  newCardStyle
}: Pick<WorktreeCardProps, 'worktree' | 'repo'> &
  Pick<Foundation, 'settings' | 'projectGroups' | 'cardProps' | 'newCardStyle'>) {
  const gitIdentityDisplay = getWorktreeGitIdentityDisplay(worktree)
  const detachedHeadDisplay = gitIdentityDisplay?.kind === 'detached' ? gitIdentityDisplay : null
  const branch = gitIdentityDisplay?.kind === 'branch' ? gitIdentityDisplay.branchName : ''
  const workspaceScope = parseWorkspaceKey(worktree.id)
  const folderWorkspaceId =
    workspaceScope?.type === 'folder' ? workspaceScope.folderWorkspaceId : null
  const isFolder = repo ? isFolderRepo(repo) : folderWorkspaceId !== null
  // Why: project groups gate folder workspaces, so folder paths stay hidden from identity surfaces until that capability exists.
  const hasProjectGroups = projectGroups.length > 0
  const branchIdentityDisplay = !isFolder && branch.length > 0 ? branch : undefined
  const folderPathIdentityDisplay =
    isFolder && hasProjectGroups && worktree.path.trim().length > 0 ? worktree.path : undefined
  const identityDisplay = branchIdentityDisplay ?? folderPathIdentityDisplay
  const hasPathIdentityEnabled = cardProps.includes('branch')
  const showIdentityInNewCard = newCardStyle && hasPathIdentityEnabled && Boolean(identityDisplay)
  const folderMetaRowContent = newCardStyle
    ? hasPathIdentityEnabled && Boolean(folderPathIdentityDisplay)
    : isFolder
  const hostedReviewCacheKey =
    repo && branch
      ? getHostedReviewCacheKey(
          repo.path,
          branch,
          settings,
          repo.id,
          repo.connectionId,
          repo.executionHostId,
          true
        )
      : ''
  const prCacheKey =
    repo && branch
      ? getGitHubPRCacheKey(
          repo.path,
          repo.id,
          branch,
          settings,
          repo.connectionId,
          repo.executionHostId,
          true
        )
      : ''
  const issueCacheKey =
    repo && worktree.linkedIssue
      ? getIssueCacheKey(
          repo.path,
          repo.id,
          worktree.linkedIssue,
          settings,
          repo.connectionId,
          repo.executionHostId,
          true
        )
      : ''
  // Saved workspace bindings keep equal Linear identifiers separate.
  const linearSourceContext = useMemo(
    () => getWorkspaceAttachmentSourceContext('linear', repo, worktree),
    [repo, worktree]
  )
  const linearWorkspaceId = getWorkspaceReferenceLinearWorkspaceId(
    worktree.linkedLinearIssueWorkspaceId,
    linearSourceContext
  )
  const linearIssueCacheKey = worktree.linkedLinearIssue
    ? scopedLinearCacheKey(
        getLinearReadScope(settings, linearSourceContext),
        `${linearWorkspaceId}::${worktree.linkedLinearIssue}`
      )
    : ''

  // Subscribe to ONLY the specific cache entry, not entire review/issue caches.
  const hostedReviewEntry = useAppStore((s) =>
    hostedReviewCacheKey ? s.hostedReviewCache[hostedReviewCacheKey] : undefined
  )
  const prCacheEntry = useAppStore((s) => (prCacheKey ? s.prCache?.[prCacheKey] : undefined))
  const issueEntry = useAppStore((s) => (issueCacheKey ? s.issueCache[issueCacheKey] : undefined))
  const linearIssueEntry = useAppStore((s) =>
    linearIssueCacheKey ? s.linearIssueCache[linearIssueCacheKey] : undefined
  )
  const linearIssueFallbackEntry = useAppStore((s) =>
    !linearSourceContext && worktree.linkedLinearIssue
      ? s.linearIssueCache[worktree.linkedLinearIssue]
      : undefined
  )
  const review = resolveWorkspaceReview(worktree, hostedReviewEntry, prCacheEntry)
  return {
    detachedHeadDisplay,
    branch,
    folderWorkspaceId,
    isFolder,
    branchIdentityDisplay,
    folderPathIdentityDisplay,
    identityDisplay,
    showIdentityInNewCard,
    folderMetaRowContent,
    hostedReviewCacheKey,
    issueCacheKey,
    issueEntry,
    linearIssueEntry,
    linearIssueFallbackEntry,
    linearSourceContext,
    linearWorkspaceId,
    ...review
  }
}
