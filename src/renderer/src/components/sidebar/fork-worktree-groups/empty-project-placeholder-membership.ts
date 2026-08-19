import type { ProjectGroup, Repo, Worktree } from '../../../../../shared/types'

export function hasOnlyWorktreesGroupedElsewhere(
  repo: Repo,
  visibleWorktrees: readonly Worktree[],
  projectGroups: readonly ProjectGroup[]
): boolean {
  const ownWorktrees = visibleWorktrees.filter((worktree) => worktree.repoId === repo.id)
  const groupIds = new Set(projectGroups.map((group) => group.id))
  return (
    ownWorktrees.length > 0 &&
    ownWorktrees.every(
      (worktree) =>
        worktree.projectGroupId !== null &&
        worktree.projectGroupId !== undefined &&
        groupIds.has(worktree.projectGroupId)
    )
  )
}
