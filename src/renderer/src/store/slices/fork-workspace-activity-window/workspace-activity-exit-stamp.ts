import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { WorktreeSliceGet } from '@/store/slices/worktrees/listing/worktree-slice-types'

/** Stamps the workspace being left after an accepted activation transition. */
export function markWorkspaceActivityExitOnActivation(
  get: WorktreeSliceGet,
  previousWorkspaceId: string | null,
  previousHostId: ExecutionHostId | null,
  nextWorkspaceId: string | null,
  nextHostId: ExecutionHostId | null
): void {
  if (
    previousWorkspaceId === null ||
    (previousWorkspaceId === nextWorkspaceId && previousHostId === nextHostId)
  ) {
    return
  }
  // Key the stamp the way the sidebar reads it — off the row's own hostId. Local rows carry none
  // while the activation records 'local', and the visit-key lookup cannot bridge that.
  const row = get().getKnownWorktreeById(previousWorkspaceId, previousHostId ?? undefined)
  get().markWorkspaceActivityExit(
    previousWorkspaceId,
    row ? row.hostId : (previousHostId ?? undefined)
  )
}
