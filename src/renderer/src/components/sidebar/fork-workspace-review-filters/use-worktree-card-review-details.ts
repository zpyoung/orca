// FORK-COPY-OF: src/renderer/src/components/sidebar/use-worktree-card-review-details.ts
// FORK-COPY-SHA: 071747853f5995ee233b36751613f09a60007c2b
import { useMemo } from 'react'
import { getDetachedWorkspaceReviewRequest } from '../workspace-detached-review-request'
import { getTaskSourceCacheScope } from '../../../../../shared/task-source-context'
import { getWorkspaceAttachmentSourceContext } from '../workspace-attachment-source-result'
import { getWorkspaceReferenceLinearWorkspaceId } from '../workspace-reference-details'
import { getWorktreeGitIdentityDisplay } from '../../../../../shared/worktree/git-identity-display'
import { useAppStore } from '@/store'
import { getGitHubPRCacheKey } from '../../../../../shared/github/github-cache-key'
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
  const hostedReviewExactKey = getDetachedWorkspaceReviewRequest(worktree, repo)?.key
  const hostedReviewCacheKey =
    hostedReviewExactKey ??
    (repo && branch
      ? getHostedReviewCacheKey(
          repo.path,
          branch,
          settings,
          repo.id,
          repo.connectionId,
          repo.executionHostId,
          true
        )
      : '')
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
  // Why: a card only reads Linear data a saved source scopes; the row-less default scope adds no
  // key prefix, so no focused-server lookup is needed.
  const linearCachePrefix = linearSourceContext
    ? getTaskSourceCacheScope(linearSourceContext)
    : null
  const linearIssueKey = `${linearWorkspaceId}::${worktree.linkedLinearIssue}`
  const linearIssueCacheKey = worktree.linkedLinearIssue
    ? linearCachePrefix
      ? `${linearCachePrefix}::${linearIssueKey}`
      : linearIssueKey
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
