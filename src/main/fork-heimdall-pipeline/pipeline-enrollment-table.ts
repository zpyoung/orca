import type Database from '../sqlite/sync-database'

export const BUILTIN_ENROLLMENT_TABLES = {
  enrollment: 'heimdall_enrollment',
  pendingPurge: 'heimdall_pending_kind_purge',
  pendingPurgeHasKind: true
} as const

export const PIPELINE_ENROLLMENT_TABLES = {
  enrollment: 'heimdall_pipeline_enrollment',
  pendingPurge: 'heimdall_pipeline_pending_purge',
  pendingPurgeHasKind: false
} as const

export type EnrollmentTableSet =
  | typeof BUILTIN_ENROLLMENT_TABLES
  | typeof PIPELINE_ENROLLMENT_TABLES

const PIPELINE_SIDE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS heimdall_pipeline_enrollment (
  watcher_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  execution_host_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  worktree_id TEXT,
  workspace_path TEXT NOT NULL,
  scheduler_owner TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  capabilities_json TEXT NOT NULL,
  budget_json TEXT NOT NULL,
  kind_payload_json TEXT NOT NULL,
  coordinator_handle TEXT NOT NULL,
  coordinator_pane_key TEXT NOT NULL,
  orchestration_run_id TEXT,
  created_at_ms INTEGER NOT NULL,
  terminal_at_ms INTEGER,
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  command_revision INTEGER NOT NULL DEFAULT 0 CHECK (command_revision >= 0),
  owner_json TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS heimdall_pipeline_enrollment_live_workspace
  ON heimdall_pipeline_enrollment (workspace_key)
  WHERE terminal_at_ms IS NULL;
CREATE TABLE IF NOT EXISTS heimdall_pipeline_pending_purge (
  watcher_id TEXT PRIMARY KEY
);
`

export function ensurePipelineSideTables(connection: Database.Database): void {
  connection.exec(PIPELINE_SIDE_TABLES_SQL)
}
