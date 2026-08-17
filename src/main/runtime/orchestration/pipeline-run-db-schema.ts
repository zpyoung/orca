import type Database from '../../sqlite/sync-database'

/**
 * Additive, idempotent DDL for the pipeline-specific tables (tech.md §5.1/§5.2). No existing
 * table's schema changes — the `tasks` table in particular stays untouched (fence F1).
 */
export function ensurePipelineRunSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      run_id                  TEXT PRIMARY KEY REFERENCES runs(id),
      template_name           TEXT NOT NULL,
      template_version        INTEGER NOT NULL,
      run_number              INTEGER NOT NULL,
      needs_newer_orca        INTEGER NOT NULL DEFAULT 0,
      state                   TEXT NOT NULL CHECK(state IN
        ('setup','running','paused','completed','failed','aborted','interrupted')),
      failure_reason          TEXT,
      input_text              TEXT NOT NULL,
      snapshot_json           TEXT NOT NULL,
      workspace_id            TEXT,
      workspace_display_name  TEXT NOT NULL,
      base_commit             TEXT,
      branch                  TEXT,
      run_worktree_id         TEXT,
      created_at              TEXT NOT NULL,
      updated_at              TEXT NOT NULL,
      ended_at                TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_runs_template_number
      ON pipeline_runs(template_name, run_number);

    CREATE TABLE IF NOT EXISTS pipeline_nodes (
      run_id              TEXT NOT NULL REFERENCES pipeline_runs(run_id),
      node_id             TEXT NOT NULL,
      node_index          INTEGER NOT NULL,
      task_id             TEXT NOT NULL,
      title               TEXT NOT NULL,
      retries_allowed     INTEGER NOT NULL,
      outcome             TEXT CHECK(outcome IN ('succeeded','failed')),
      outcome_reason      TEXT,
      prelaunch_failures  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (run_id, node_id)
    );

    CREATE TABLE IF NOT EXISTS pipeline_attempts (
      run_id              TEXT NOT NULL,
      node_id             TEXT NOT NULL,
      attempt             INTEGER NOT NULL,
      dispatch_id         TEXT,
      checkpoint_head     TEXT,
      checkpoint_snapshot TEXT,
      checkpoint_ref      TEXT,
      started_at          TEXT NOT NULL,
      ended_at            TEXT,
      outcome             TEXT CHECK(outcome IN ('succeeded','failed')),
      failure_stage       TEXT,
      PRIMARY KEY (run_id, node_id, attempt)
    );

    CREATE TABLE IF NOT EXISTS pipeline_run_counters (
      template_name  TEXT PRIMARY KEY,
      last_number    INTEGER NOT NULL
    );
  `)
}
