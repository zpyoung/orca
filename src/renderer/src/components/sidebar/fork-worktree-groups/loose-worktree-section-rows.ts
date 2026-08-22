import type { ProjectGroup } from '../../../../../shared/project-group-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { Row } from '../worktree-list/grouping/row-types'
import { appendWorktreeRows } from '../worktree-list/grouping/row-builders'
import { getProjectGroupExecutionHostIdForRows } from '../worktree-list/listing/host-filtering'
import type { SectionAppendContext } from '../worktree-list/grouping/group-sections'
import {
  getDivertedWorktreeProjectGroupId,
  getLooseWorktreeHostContextLabels,
  LOOSE_WORKTREE_SECTION_KEY_SUFFIX
} from './worktree-loose-group-membership'

export type LooseWorktreesByProjectGroupId = ReadonlyMap<string, Worktree[]>

/**
 * Buckets the worktrees that render under a Project Group instead of their own repo.
 *
 * Display-only membership: a loose worktree keeps its repo root-level and never changes
 * execution routing. Returns an empty map outside `groupBy: 'repo'`, where Project Group
 * sections are not rendered at all.
 */
export function collectLooseWorktreesByProjectGroupId(
  naturalWorktrees: readonly Worktree[],
  groupBy: string,
  projectGroups: readonly ProjectGroup[]
): Map<string, Worktree[]> {
  const looseByGroupId = new Map<string, Worktree[]>()
  if (groupBy !== 'repo' || projectGroups.length === 0) {
    return looseByGroupId
  }
  const projectGroupsById = new Map(
    projectGroups.map((projectGroup) => [projectGroup.id, projectGroup])
  )
  for (const worktree of naturalWorktrees) {
    const groupId = getDivertedWorktreeProjectGroupId(worktree, projectGroupsById)
    if (!groupId) {
      continue
    }
    const looseList = looseByGroupId.get(groupId) ?? []
    looseList.push(worktree)
    looseByGroupId.set(groupId, looseList)
  }
  return looseByGroupId
}

/** Identities of every diverted worktree, so repo bucketing can skip them. */
export function getLooseWorktreeIds(looseByGroupId: LooseWorktreesByProjectGroupId): Set<string> {
  const ids = new Set<string>()
  for (const worktrees of looseByGroupId.values()) {
    for (const worktree of worktrees) {
      ids.add(worktree.id)
    }
  }
  return ids
}

/** Renders a Project Group's loose worktrees directly under its header. */
export function appendLooseWorktreeSectionRows(
  ctx: SectionAppendContext,
  args: {
    result: Row[]
    projectGroup: ProjectGroup
    headerKey: string
    depth: number
    looseWorktrees: readonly Worktree[]
  }
): void {
  const { result, projectGroup, headerKey, depth, looseWorktrees } = args
  if (looseWorktrees.length === 0) {
    return
  }
  const baselineHostId = getProjectGroupExecutionHostIdForRows(projectGroup, ctx.defaultHostId)
  // Why: incoming order only — orderMainWorktreeFirst encodes "a repo's main checkout
  // heads its own section," which is meaningless once a group spans repos and would
  // hoist a member for no visible reason.
  appendWorktreeRows(result, [...looseWorktrees], ctx.repoMap, ctx.lineageById, ctx.worktreeMap, {
    nestLineage: ctx.nestLineage,
    collapsedGroups: ctx.collapsedGroups,
    groupDepth: depth + 1,
    sectionKey: `${headerKey}${LOOSE_WORKTREE_SECTION_KEY_SUFFIX}`,
    hostContextLabelByWorktreeIdentity: getLooseWorktreeHostContextLabels(
      looseWorktrees,
      ctx.repoMap,
      ctx.hostLabelById,
      ctx.defaultHostId,
      baselineHostId
    ),
    cyclicLineageIds: ctx.cyclicLineageIds
  })
}
