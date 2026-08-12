import type Database from '../../sqlite/sync-database'
import type { PipelineRunState } from '../../../shared/pipeline-run-snapshot'
import type { PipelineAttemptRow, PipelineNodeRow, PipelineRunRow } from './pipeline-run-db-types'

const TERMINAL_PIPELINE_RUN_STATES: ReadonlySet<PipelineRunState> = new Set([
  'completed',
  'failed',
  'aborted',
  'interrupted'
])

const DRIVER_LOST_REASON = 'driver lost: host process exited while the run was active'

export function getPipelineRun(db: Database.Database, runId: string): PipelineRunRow | undefined {
  return db.prepare('SELECT * FROM pipeline_runs WHERE run_id = ?').get(runId) as
    | PipelineRunRow
    | undefined
}

export function listPipelineRuns(
  db: Database.Database,
  filter?: { workspaceId?: string }
): PipelineRunRow[] {
  if (filter?.workspaceId) {
    return db
      .prepare(
        'SELECT * FROM pipeline_runs WHERE workspace_id = ? ORDER BY created_at DESC, run_id DESC'
      )
      .all(filter.workspaceId) as PipelineRunRow[]
  }
  return db
    .prepare('SELECT * FROM pipeline_runs ORDER BY created_at DESC, run_id DESC')
    .all() as PipelineRunRow[]
}

export function getPipelineNodes(db: Database.Database, runId: string): PipelineNodeRow[] {
  return db
    .prepare('SELECT * FROM pipeline_nodes WHERE run_id = ? ORDER BY node_index')
    .all(runId) as PipelineNodeRow[]
}

export function getPipelineAttempts(
  db: Database.Database,
  runId: string,
  nodeId?: string
): PipelineAttemptRow[] {
  if (nodeId) {
    return db
      .prepare(
        'SELECT * FROM pipeline_attempts WHERE run_id = ? AND node_id = ? ORDER BY attempt'
      )
      .all(runId, nodeId) as PipelineAttemptRow[]
  }
  return db
    .prepare('SELECT * FROM pipeline_attempts WHERE run_id = ? ORDER BY node_id, attempt')
    .all(runId) as PipelineAttemptRow[]
}

/** Pre: run state is `setup`. Never called for folder-workspace runs. */
export function recordWorktreeSetup(
  db: Database.Database,
  runId: string,
  args: { branch: string; runWorktreeId: string }
): void {
  db.prepare(
    'UPDATE pipeline_runs SET branch = ?, run_worktree_id = ?, updated_at = ? WHERE run_id = ?'
  ).run(args.branch, args.runWorktreeId, new Date().toISOString(), runId)
}

/**
 * Idempotent for same-state writes. Terminal states are absorbing: a terminal→anything
 * transition is a no-op that returns without writing (drives L22 idempotency, makes the E7
 * sweep safe to re-run).
 */
export function updateRunState(
  db: Database.Database,
  runId: string,
  state: PipelineRunState,
  opts?: { failureReason?: string }
): void {
  const current = getPipelineRun(db, runId)
  if (!current || TERMINAL_PIPELINE_RUN_STATES.has(current.state)) {
    return
  }
  const now = new Date().toISOString()
  const isTerminal = TERMINAL_PIPELINE_RUN_STATES.has(state)
  db.prepare(
    `UPDATE pipeline_runs
     SET state = ?, failure_reason = COALESCE(?, failure_reason), updated_at = ?,
         ended_at = CASE WHEN ? THEN ? ELSE ended_at END
     WHERE run_id = ?`
  ).run(state, opts?.failureReason ?? null, now, isTerminal ? 1 : 0, now, runId)
}

/** Startup sweep (→ logic E7): every run last known live is marked interrupted, driver-lost. */
export function markOrphanedRunsInterrupted(db: Database.Database): string[] {
  const rows = db
    .prepare(
      "SELECT run_id FROM pipeline_runs WHERE state IN ('setup', 'running', 'paused')"
    )
    .all() as { run_id: string }[]
  const runIds = rows.map((row) => row.run_id)
  for (const runId of runIds) {
    updateRunState(db, runId, 'interrupted', { failureReason: DRIVER_LOST_REASON })
  }
  return runIds
}
