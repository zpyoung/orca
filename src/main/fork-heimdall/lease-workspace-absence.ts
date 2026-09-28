import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { WorkspaceKey } from '../../shared/fork-heimdall/watcher-types'
import { OrchestrationError } from '../runtime/orchestration/orchestration-error'

export class LeaseWorkspaceRemovedError extends Error {}

export function isRemovedWorkspaceResolution(error: unknown, key: WorkspaceKey): boolean {
  if (error instanceof OrchestrationError) {
    return (
      error.code === 'selector_not_found' ||
      error.code === 'worktree_not_found' ||
      error.code === 'worktree_not_found_on_server'
    )
  }
  // A plain selector miss on SSH is client bookkeeping, not a host absence verdict.
  return (
    key.startsWith(`${LOCAL_EXECUTION_HOST_ID}::`) &&
    error instanceof Error &&
    error.message === 'selector_not_found'
  )
}
