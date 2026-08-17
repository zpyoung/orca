/**
 * Whether a task or dispatch row falls outside the run a lifecycle reconciler is scoped to.
 * `runId` is optional so unscoped callers (non-coordinator reconcile paths) see no change.
 */
export function isOutOfRunScope(row: { run_id: string }, runId: string | undefined): boolean {
  return runId !== undefined && row.run_id !== runId
}
