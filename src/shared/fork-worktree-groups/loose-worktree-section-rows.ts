import type { ProjectGroup } from '../project-group-types'
import type { Worktree } from '../worktree/types'
import type { OccurrenceSectionPath, WorktreeOccurrenceSection } from '../worktree-occurrence-plan'
import type { SectionAppendContext } from '../sidebar-list/group-sections'
import { getProjectGroupExecutionHostIdForRows } from '../sidebar-list/host-filtering'
import { appendWorktreeRows } from '../sidebar-list/row-builders'
import type { WorktreeGroupEntry } from '../sidebar-list/worktree-group-entry'
import {
  getDivertedWorktreeProjectGroupId,
  getLooseWorktreeHostContextLabels,
  getLooseWorktreeSectionKey
} from './worktree-loose-group-membership'

type LooseWorktreeOccurrenceSection = WorktreeOccurrenceSection<Worktree> & {
  group: WorktreeGroupEntry
}

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

/**
 * Splits loose worktrees out of the natural placement so they skip repo bucketing, and
 * returns one occurrence section per Project Group, revealed through that group's header.
 */
export function splitLooseWorktreeSections(
  naturalWorktrees: readonly Worktree[],
  args: {
    groupBy: string
    projectGroups: readonly ProjectGroup[]
    projectGroupPaths: ReadonlyMap<string, OccurrenceSectionPath>
  }
): { natural: readonly Worktree[]; looseSections: LooseWorktreeOccurrenceSection[] } {
  const looseByGroupId = collectLooseWorktreesByProjectGroupId(
    naturalWorktrees,
    args.groupBy,
    args.projectGroups
  )
  if (looseByGroupId.size === 0) {
    return { natural: naturalWorktrees, looseSections: [] }
  }
  const looseIds = new Set<string>()
  for (const worktrees of looseByGroupId.values()) {
    for (const worktree of worktrees) {
      looseIds.add(worktree.id)
    }
  }
  const looseSections = [...looseByGroupId].map(
    ([groupId, items]): LooseWorktreeOccurrenceSection => {
      const key = getLooseWorktreeSectionKey(groupId)
      return {
        key,
        group: { label: '', items, repoIds: new Set() },
        placement: 'natural',
        items,
        revealPath: { key, parent: args.projectGroupPaths.get(groupId) }
      }
    }
  )
  return {
    natural: naturalWorktrees.filter((worktree) => !looseIds.has(worktree.id)),
    looseSections
  }
}

/** How many worktrees a Project Group shows directly under its header. */
export function getLooseWorktreeCount(ctx: SectionAppendContext, projectGroupId: string): number {
  return ctx.occurrencePlan.bySection.get(getLooseWorktreeSectionKey(projectGroupId))?.length ?? 0
}

/** Renders a Project Group's loose worktrees directly under its header. */
export function appendLooseWorktreeSectionRows(
  ctx: SectionAppendContext,
  args: { projectGroup: ProjectGroup; depth: number }
): void {
  const { projectGroup, depth } = args
  const sectionKey = getLooseWorktreeSectionKey(projectGroup.id)
  const occurrences = ctx.occurrencePlan.bySection.get(sectionKey) ?? []
  if (occurrences.length === 0) {
    return
  }
  const baselineHostId = getProjectGroupExecutionHostIdForRows(projectGroup, ctx.defaultHostId)
  appendWorktreeRows(ctx.result, ctx.repoMap, ctx.occurrencePlan, {
    collapsedGroups: ctx.collapsedGroups,
    groupDepth: depth + 1,
    sectionKey,
    hostContextLabelByWorktreeIdentity: getLooseWorktreeHostContextLabels(
      occurrences.map((occurrence) => occurrence.row),
      ctx.repoMap,
      ctx.hostLabelById,
      ctx.defaultHostId,
      baselineHostId
    )
  })
}
