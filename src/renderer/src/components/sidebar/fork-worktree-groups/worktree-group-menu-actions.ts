import type { WorktreeMetaUpdateOptions } from '@/store/slices/worktree-helpers'
import type { ProjectGroup, RepoKind, Worktree } from '../../../../../shared/types'
import { canWorktreeHoldGroupMembership } from '../../../../../shared/fork-worktree-groups/worktree-group-membership'

export type WorktreeGroupMenuVisibility = {
  showWorktreeCreate: boolean
  showAddSubmenu: boolean
  showProjectCreate: boolean
}

// Why: derives worktree-vs-project group-menu visibility from one
// `canHoldMembership` gate. Rows that cannot hold membership fall back to the
// honestly-scoped project action instead. A repo-less folder workspace has no
// project to target, so showProjectCreate also requires `hasRepo` — the
// invariant is never both, not always exactly one.
export function getWorktreeGroupMenuVisibility(
  folderWorkspaceId: string | null,
  projectGroups: readonly Pick<ProjectGroup, 'id'>[],
  repoKind: RepoKind | undefined,
  hasRepo: boolean
): WorktreeGroupMenuVisibility {
  const canHoldMembership = canWorktreeHoldGroupMembership({ folderWorkspaceId, repoKind })
  return {
    showWorktreeCreate: canHoldMembership,
    showAddSubmenu: canHoldMembership && projectGroups.length > 0,
    showProjectCreate: !canHoldMembership && hasRepo
  }
}

export function shouldShowRemoveWorktreeFromGroup(
  worktree: Pick<Worktree, 'projectGroupId'>
): boolean {
  return worktree.projectGroupId != null
}

// Why: kept as free functions (rather than inline in the useCallback) so the
// exact updateWorktreeMeta call args are unit-testable without rendering the menu.
export function addWorktreeToGroup(
  worktreeId: string,
  groupId: string,
  updateWorktreeMeta: (worktreeId: string, updates: { projectGroupId: string | null }) => void
): void {
  updateWorktreeMeta(worktreeId, { projectGroupId: groupId })
}

export function removeWorktreeFromGroup(
  worktreeId: string,
  updateWorktreeMeta: (worktreeId: string, updates: { projectGroupId: string | null }) => void
): void {
  updateWorktreeMeta(worktreeId, { projectGroupId: null })
}

// Why: mirrors addWorktreeToGroup/removeWorktreeFromGroup above — a free
// function so the create-then-assign sequence is unit-testable without
// rendering the menu. Never calls moveProjectToGroup: the new group must hold
// only this one worktree, not the whole repo.
export async function createGroupFromWorktree(
  worktree: Pick<Worktree, 'id' | 'instanceId' | 'projectGroupId'>,
  name: string,
  createProjectGroup: (name: string) => Promise<ProjectGroup | null>,
  updateWorktreeMeta: (
    worktreeId: string,
    updates: { projectGroupId: string | null },
    options?: WorktreeMetaUpdateOptions
  ) => Promise<{ ok: true } | { ok: false; error: string }>
): Promise<void> {
  // Why: createProjectGroup crosses an async gap — capture identity/membership
  // first so a delete, path-reuse replacement, or another group change mid-flight
  // isn't clobbered by this assignment landing late.
  const capturedInstanceId = worktree.instanceId ?? null
  const capturedProjectGroupId = worktree.projectGroupId ?? null
  const group = await createProjectGroup(name)
  if (group) {
    await updateWorktreeMeta(
      worktree.id,
      { projectGroupId: group.id },
      {
        shouldApply: (current) =>
          Boolean(
            current &&
            (current.instanceId ?? null) === capturedInstanceId &&
            (current.projectGroupId ?? null) === capturedProjectGroupId
          )
      }
    )
  }
}
