import type { WorktreeMeta } from '../../shared/types'

export function releaseDeletedProjectGroupWorktreeMembership(
  worktreeMeta: Record<string, WorktreeMeta | undefined>,
  deletedGroupIds: ReadonlySet<string>
): void {
  for (const [worktreeId, meta] of Object.entries(worktreeMeta)) {
    if (
      meta &&
      typeof meta.projectGroupId === 'string' &&
      deletedGroupIds.has(meta.projectGroupId)
    ) {
      worktreeMeta[worktreeId] = { ...meta, projectGroupId: null }
    }
  }
}
