import type Database from '../../sqlite/sync-database'

export type BeginAttemptArgs = {
  attempt: number
  dispatchId?: string
  checkpoint?: { head: string; snapshot: string; ref: string }
}

export type EndAttemptArgs = {
  outcome: 'succeeded' | 'failed'
  failureStage?: string
}

/** Attempt numbers are dense and 1-based per node; stage-B prelaunch cycles never create rows. */
export function beginAttempt(
  db: Database.Database,
  runId: string,
  nodeId: string,
  args: BeginAttemptArgs
): void {
  db.prepare(
    `INSERT INTO pipeline_attempts (
       run_id, node_id, attempt, dispatch_id, checkpoint_head, checkpoint_snapshot,
       checkpoint_ref, started_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    runId,
    nodeId,
    args.attempt,
    args.dispatchId ?? null,
    args.checkpoint?.head ?? null,
    args.checkpoint?.snapshot ?? null,
    args.checkpoint?.ref ?? null,
    new Date().toISOString()
  )
}

/** No-op if this attempt already ended (idempotent under driver-cycle races). */
export function endAttempt(
  db: Database.Database,
  runId: string,
  nodeId: string,
  attempt: number,
  args: EndAttemptArgs
): void {
  db.prepare(
    `UPDATE pipeline_attempts SET ended_at = ?, outcome = ?, failure_stage = ?
     WHERE run_id = ? AND node_id = ? AND attempt = ? AND ended_at IS NULL`
  ).run(new Date().toISOString(), args.outcome, args.failureStage ?? null, runId, nodeId, attempt)
}

export function setNodeOutcome(
  db: Database.Database,
  runId: string,
  nodeId: string,
  args: { outcome: 'succeeded' | 'failed'; reason?: string }
): void {
  db.prepare(
    'UPDATE pipeline_nodes SET outcome = ?, outcome_reason = ? WHERE run_id = ? AND node_id = ?'
  ).run(args.outcome, args.reason ?? null, runId, nodeId)
}

/** Consecutive stage-B prelaunch failure count; returns the value after incrementing. */
export function incrementPrelaunchFailures(
  db: Database.Database,
  runId: string,
  nodeId: string
): number {
  db.prepare(
    'UPDATE pipeline_nodes SET prelaunch_failures = prelaunch_failures + 1 WHERE run_id = ? AND node_id = ?'
  ).run(runId, nodeId)
  const row = db
    .prepare('SELECT prelaunch_failures FROM pipeline_nodes WHERE run_id = ? AND node_id = ?')
    .get(runId, nodeId) as { prelaunch_failures: number } | undefined
  return row?.prelaunch_failures ?? 0
}

export function resetPrelaunchFailures(db: Database.Database, runId: string, nodeId: string): void {
  db.prepare(
    'UPDATE pipeline_nodes SET prelaunch_failures = 0 WHERE run_id = ? AND node_id = ?'
  ).run(runId, nodeId)
}
