import type { ProjectGroup } from '../project-group-types'
import type { Repo } from '../repo-types'
import type { Worktree } from '../worktree/types'
import { getWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import {
  getExecutionHostLabel,
  getWorktreeExecutionHostId,
  type ExecutionHostId
} from '../execution-host'

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

export function getLooseWorktreeSectionKey(projectGroupId: string): string {
  return `${PROJECT_GROUP_HEADER_KEY_PREFIX}${projectGroupId}${LOOSE_WORKTREE_SECTION_KEY_SUFFIX}`
}

export function isLooseWorktreeSectionKey(sectionKey: string): boolean {
  return getLooseSectionProjectGroupId(sectionKey) !== null
}

export function getLooseWorktreeHostContextLabels(
  worktrees: readonly Worktree[],
  repoMap: Map<string, Repo>,
  hostLabelById: ReadonlyMap<string, string> | undefined,
  defaultHostId: ExecutionHostId,
  groupHostId: ExecutionHostId
): Map<string, string> | undefined {
  const labelsByWorktreeIdentity = new Map<string, string>()
  for (const worktree of worktrees) {
    const hostId = getWorktreeExecutionHostId(worktree, repoMap.get(worktree.repoId), defaultHostId)
    if (hostId !== groupHostId) {
      labelsByWorktreeIdentity.set(
        getWorktreeHostIdentity(worktree),
        hostLabelById?.get(hostId) ?? getExecutionHostLabel(hostId)
      )
    }
  }
  return labelsByWorktreeIdentity.size > 0 ? labelsByWorktreeIdentity : undefined
}
