import type { ProjectGroup, Repo, Worktree } from '../../../../shared/types'
import type { WorktreeGroupBy } from './worktree-list-groups'

export function getEmptyProjectPlaceholderRepoIds(args: {
  groupBy: WorktreeGroupBy
  repos: readonly Repo[]
  worktreesByRepo: Readonly<Record<string, readonly Worktree[] | undefined>>
  visibleWorktrees: readonly Worktree[]
  filterRepoIds: readonly string[]
  projectGroups: readonly ProjectGroup[]
}): Set<string> {
  if (args.groupBy !== 'repo') {
    return new Set()
  }

  const filterSet = args.filterRepoIds.length > 0 ? new Set(args.filterRepoIds) : null
  const visibleRepoIds = new Set(args.visibleWorktrees.map((worktree) => worktree.repoId))
  const existingProjectGroupIds = new Set(args.projectGroups.map((group) => group.id))
  const ownVisibleByRepoId = new Map<string, Worktree[]>()
  for (const worktree of args.visibleWorktrees) {
    const owned = ownVisibleByRepoId.get(worktree.repoId)
    if (owned) {
      owned.push(worktree)
    } else {
      ownVisibleByRepoId.set(worktree.repoId, [worktree])
    }
  }
  const placeholderRepoIds = new Set<string>()
  for (const repo of args.repos) {
    if (filterSet && !filterSet.has(repo.id)) {
      continue
    }
    const hasNoWorktrees = (args.worktreesByRepo[repo.id]?.length ?? 0) === 0
    // Why: workspace filters hide cards, but must not rewrite the visible
    // membership of a persisted Project Group. #8865
    const isFilteredProjectGroupMember = repo.projectGroupId != null && !visibleRepoIds.has(repo.id)
    const ownVisible = ownVisibleByRepoId.get(repo.id) ?? []
    // A repo whose worktrees were all pulled into cross-repo groups elsewhere
    // must still render as a placeholder: it stays a root-level project and
    // a drop target. `length > 0` guards the vacuous `every()` on an empty
    // array, which would otherwise wrongly flag a repo hidden entirely by a
    // host filter (that case belongs to `hasNoWorktrees` only).
    const isFullyGroupedElsewhere =
      ownVisible.length > 0 &&
      ownVisible.every(
        (worktree) =>
          worktree.projectGroupId != null && existingProjectGroupIds.has(worktree.projectGroupId)
      )
    if (hasNoWorktrees || isFilteredProjectGroupMember || isFullyGroupedElsewhere) {
      placeholderRepoIds.add(repo.id)
    }
  }
  return placeholderRepoIds
}
