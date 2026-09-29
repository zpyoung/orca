import { OrchestrationError } from '../../runtime/orchestration/orchestration-error'

export function isWorkspaceAbsenceCandidate(error: unknown): boolean {
  if (error instanceof OrchestrationError) {
    return (
      error.code === 'selector_not_found' ||
      error.code === 'worktree_not_found' ||
      error.code === 'worktree_not_found_on_server'
    )
  }
  return error instanceof Error && error.message === 'selector_not_found'
}

export function isServerReportedWorkspaceAbsence(error: unknown): boolean {
  return error instanceof OrchestrationError && error.code === 'worktree_not_found_on_server'
}
