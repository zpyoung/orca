import type { AppState } from '../../types'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import { findKnownWorktreeById } from '../worktrees/listing/detected-worktree-meta'
import {
  stampWorkspaceActivityExit,
  type WorkspaceActivityWindowSlice
} from './workspace-activity-window-state'

/**
 * Patch stamping the workspace an accepted activation is leaving.
 *
 * Returns a patch rather than writing, so the stamp lands in the activation's own `set()` — a
 * second commit would publish a frame where the new workspace is active and the old one unstamped.
 */
export function workspaceActivityExitPatchForActivation(
  state: AppState,
  previousWorkspaceId: string | null,
  previousHostId: ExecutionHostId | null,
  nextWorkspaceId: string | null,
  nextHostId: ExecutionHostId | null
): Partial<WorkspaceActivityWindowSlice> {
  if (
    previousWorkspaceId === null ||
    (previousWorkspaceId === nextWorkspaceId && previousHostId === nextHostId)
  ) {
    return {}
  }
  // An activation that names an unknown workspace still commits, so acceptance is checked here
  // rather than inferred from the commit.
  if (
    nextWorkspaceId !== null &&
    !findKnownWorktreeById(state, nextWorkspaceId, nextHostId ?? undefined)
  ) {
    return {}
  }
  // Key the stamp the way the sidebar reads it — off the row's own hostId. Local rows carry none
  // while the activation records 'local', and the visit-key lookup cannot bridge that.
  const row = findKnownWorktreeById(state, previousWorkspaceId, previousHostId ?? undefined)
  return stampWorkspaceActivityExit(
    state.workspaceActivityExitStamps,
    previousWorkspaceId,
    row ? row.hostId : (previousHostId ?? undefined)
  )
}
