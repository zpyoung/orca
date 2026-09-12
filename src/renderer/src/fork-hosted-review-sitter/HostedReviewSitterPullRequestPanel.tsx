import React from 'react'
import { Bot } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { getWorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'
import { useAppStore } from '@/store'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { Worktree } from '../../../shared/worktree/types'
import { HostedReviewSitterReviewPanel } from './HostedReviewSitterPanel'

export type HostedReviewSitterPullRequestPanelProps = {
  workItem: GitHubWorkItem
  effectiveRepoId: string | null
  attachedWorkspace: Worktree | null
}

function PullRequestSitterUnavailable({ reason }: { reason: string }): React.JSX.Element {
  return (
    <section
      className="border-b border-border bg-muted/10 px-3 py-3"
      aria-label={translate('fork.hostedReviewSitter.title', 'PR Sitter')}
    >
      <div className="flex items-center gap-2">
        <Bot className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="text-xs font-medium text-foreground">
          {translate('fork.hostedReviewSitter.title', 'PR Sitter')}
        </span>
      </div>
      <div
        className="mt-2 rounded-md border border-border bg-background/60 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground"
        role="status"
      >
        <span className="font-medium text-foreground">
          {translate('fork.hostedReviewSitter.unavailable.title', 'Unavailable.')}
        </span>{' '}
        {reason}
      </div>
    </section>
  )
}

/** Adapts the PR page's explicit review-to-workspace association to the shared sitter panel. */
export function HostedReviewSitterPullRequestPanel({
  workItem,
  effectiveRepoId,
  attachedWorkspace
}: HostedReviewSitterPullRequestPanelProps): React.JSX.Element | null {
  const repo = useAppStore((state) =>
    effectiveRepoId
      ? (state.repos.find((candidate) => candidate.id === effectiveRepoId) ?? null)
      : null
  )

  if (workItem.type !== 'pr') {
    return null
  }

  const sourceWorkspace =
    effectiveRepoId &&
    attachedWorkspace?.repoId === effectiveRepoId &&
    attachedWorkspace.linkedPR === workItem.number &&
    !attachedWorkspace.isArchived
      ? attachedWorkspace
      : null

  if (!sourceWorkspace) {
    return (
      <PullRequestSitterUnavailable
        reason={translate(
          'fork.hostedReviewSitter.unavailable.noSourceWorkspace',
          'Link or create a source workspace for this pull request before configuring PR Sitter.'
        )}
      />
    )
  }
  if (!repo) {
    return (
      <PullRequestSitterUnavailable
        reason={translate(
          'fork.hostedReviewSitter.unavailable.sourceRepository',
          'The linked source workspace repository is unavailable.'
        )}
      />
    )
  }

  const identity = getWorktreeGitIdentityDisplay(sourceWorkspace)
  return (
    <HostedReviewSitterReviewPanel
      repoId={repo.id}
      worktreeId={sourceWorkspace.id}
      repoPath={sourceWorkspace.path}
      branch={identity?.kind === 'branch' ? identity.branchName : ''}
      reviewProvider="github"
      reviewNumber={workItem.number}
      reviewUrl={workItem.url}
      reviewState={workItem.state}
    />
  )
}
