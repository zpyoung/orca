import type { Repo } from '../../../../../shared/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import { getWorktreeVisitTimestamp } from '@/lib/worktree-visit-recency'
import type { WorkspaceActivityWindow } from '../../../../../shared/fork-workspace-activity-window/workspace-activity-window'

export type WorkspaceActivityFilterContext = {
  workspaceActivityWindow: WorkspaceActivityWindow
  workspaceActivityCustomDays: number
  lastVisitedAtByWorktreeId: Readonly<Record<string, number>>
  workspaceActivityExitStamps: Readonly<Record<string, number>>
  selectedWorkspaceId: string | null
  selectedHostId: ExecutionHostId | null
  now: number
}

export function workspaceActivityWindowDays(
  window: WorkspaceActivityWindow,
  customDays: number
): number | null {
  if (window === 'today') {
    return 1
  }
  if (window === 'week') {
    return 7
  }
  if (window === 'month') {
    return 30
  }
  if (window === 'custom') {
    return customDays
  }
  return null
}

function activityTime(
  worktree: Worktree,
  context: WorkspaceActivityFilterContext,
  repoMap: Map<string, Repo>
): number {
  const visited = getWorktreeVisitTimestamp(context.lastVisitedAtByWorktreeId, worktree) ?? 0
  const exited = getWorktreeVisitTimestamp(context.workspaceActivityExitStamps, worktree) ?? 0
  return (
    Math.max(worktree.lastActivityAt || 0, visited, exited) ||
    (worktree.createdAt ?? repoMap.get(worktree.repoId)?.addedAt ?? 0)
  )
}

export function isSelectedActivityWorkspace(
  worktree: Pick<Worktree, 'id' | 'hostId'>,
  context: WorkspaceActivityFilterContext | undefined
): boolean {
  if (
    !context ||
    context.selectedWorkspaceId === null ||
    worktree.id !== context.selectedWorkspaceId
  ) {
    return false
  }
  // an unqualified row or an unqualified selection means "any host", matching findKnownWorktreeById:
  // local rows carry no hostId, so a strict equality check drops the open workspace off the list.
  return (
    context.selectedHostId === null ||
    worktree.hostId === undefined ||
    worktree.hostId === context.selectedHostId
  )
}

export function filterWorktreesByActivity(
  worktrees: Worktree[],
  context: WorkspaceActivityFilterContext | undefined,
  repoMap: Map<string, Repo>
): Worktree[] {
  if (
    !context ||
    context.workspaceActivityWindow === 'all' ||
    context.workspaceActivityWindow === 'live-only'
  ) {
    return worktrees
  }
  const days = workspaceActivityWindowDays(
    context.workspaceActivityWindow,
    context.workspaceActivityCustomDays
  )
  if (days === null) {
    return worktrees
  }
  const cutoff = context.now - days * 86400000
  return worktrees.filter(
    (worktree) =>
      isSelectedActivityWorkspace(worktree, context) ||
      activityTime(worktree, context, repoMap) >= cutoff
  )
}
