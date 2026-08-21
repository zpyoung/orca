import type { ProjectGroup } from '../../../../../shared/project-group-types'
import type { Repo } from '../../../../../shared/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import {
  getExecutionHostLabel,
  getWorktreeExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host'

export const LOOSE_WORKTREE_SECTION_KEY_SUFFIX = '::loose'
const PROJECT_GROUP_HEADER_KEY_PREFIX = 'project-group:'

export function getLooseSectionProjectGroupId(sectionKey: string): string | null {
  if (!sectionKey.endsWith(LOOSE_WORKTREE_SECTION_KEY_SUFFIX)) {
    return null
  }
  const headerKey = sectionKey.slice(0, -LOOSE_WORKTREE_SECTION_KEY_SUFFIX.length)
  return headerKey.startsWith(PROJECT_GROUP_HEADER_KEY_PREFIX)
    ? headerKey.slice(PROJECT_GROUP_HEADER_KEY_PREFIX.length)
    : null
}

export function isLooseProjectGroupTopRow(sectionKey: string, nested: boolean): boolean {
  return !nested && getLooseSectionProjectGroupId(sectionKey) !== null
}

export function getDivertedWorktreeProjectGroupId(
  worktree: Worktree,
  projectGroupsById: ReadonlyMap<string, ProjectGroup>
): string | null {
  return worktree.projectGroupId && projectGroupsById.has(worktree.projectGroupId)
    ? worktree.projectGroupId
    : null
}

export function getWorktreeGroupRevealSectionKey(
  divertedGroupId: string | null,
  defaultSectionKey: string
): string {
  return divertedGroupId === null
    ? defaultSectionKey
    : `${PROJECT_GROUP_HEADER_KEY_PREFIX}${divertedGroupId}${LOOSE_WORKTREE_SECTION_KEY_SUFFIX}`
}

export function getLooseWorktreeHostContextLabels(
  worktrees: readonly Worktree[],
  repoMap: Map<string, Repo>,
  hostLabelById: ReadonlyMap<string, string> | undefined,
  defaultHostId: ExecutionHostId,
  groupHostId: ExecutionHostId
): Map<string, string> | undefined {
  const labelsByWorktreeId = new Map<string, string>()
  for (const worktree of worktrees) {
    const hostId = getWorktreeExecutionHostId(worktree, repoMap.get(worktree.repoId), defaultHostId)
    if (hostId !== groupHostId) {
      labelsByWorktreeId.set(
        worktree.id,
        hostLabelById?.get(hostId) ?? getExecutionHostLabel(hostId)
      )
    }
  }
  return labelsByWorktreeId.size > 0 ? labelsByWorktreeId : undefined
}
