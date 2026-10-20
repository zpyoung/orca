import type Database from '../sqlite/sync-database'
import {
  ScopedSqliteDatabase,
  type ScopedDatabaseDirectorySource
} from '../fork-heimdall/scoped-sqlite-database'

export const PIPELINE_DATABASE_SCHEMA_VERSION = 4
export const PIPELINE_DATABASE_BUSY_TIMEOUT_MS = 5_000

const PIPELINE_SCHEMA_V1_SQL = `
CREATE TABLE pipeline_run_pin (
  watcher_id TEXT PRIMARY KEY,
  ref TEXT NOT NULL,
  scope TEXT NOT NULL,
  pipeline_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  document_version INTEGER NOT NULL,
  run_number INTEGER NOT NULL,
  recorded_at_ms INTEGER NOT NULL
);
CREATE INDEX pipeline_run_pin_ref_run_number
  ON pipeline_run_pin (ref, run_number);

CREATE TABLE pipeline_node_output (
  watcher_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  outputs_json TEXT NOT NULL,
  report_sha256 TEXT,
  recorded_at_ms INTEGER NOT NULL,
  PRIMARY KEY (watcher_id, instance_id, epoch, attempt)
);

CREATE TABLE pipeline_dispatch (
  watcher_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  dispatch_id TEXT NOT NULL,
  workspace_id TEXT,
  terminal_handle TEXT,
  report_path TEXT NOT NULL,
  dispatched_at_ms INTEGER NOT NULL,
  PRIMARY KEY (watcher_id, instance_id, epoch, attempt)
);

CREATE TABLE pipeline_attempt_baseline (
  watcher_id TEXT NOT NULL,
  attempt_fingerprint TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  digest_json TEXT NOT NULL,
  PRIMARY KEY (watcher_id, attempt_fingerprint)
);

CREATE TABLE pipeline_swarm_expansion (
  watcher_id TEXT NOT NULL,
  swarm_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  tasks_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  base_commit TEXT,
  PRIMARY KEY (watcher_id, swarm_id, epoch)
);

CREATE TABLE pipeline_child_worktree (
  watcher_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  worktree_id TEXT NOT NULL,
  setup_state TEXT NOT NULL,
  PRIMARY KEY (watcher_id, instance_id, epoch)
);

CREATE TABLE pipeline_merge_progress (
  watcher_id TEXT NOT NULL,
  merge_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  child_instance_id TEXT NOT NULL,
  state TEXT NOT NULL,
  commit_sha TEXT,
  applied_commit_sha TEXT,
  conflict_json TEXT,
  PRIMARY KEY (watcher_id, merge_id, epoch, child_instance_id)
);

CREATE TABLE pipeline_composite (
  watcher_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  kind TEXT NOT NULL,
  kind_payload_json TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  activated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (watcher_id, instance_id, epoch)
);
`

const PIPELINE_SCHEMA_V2_SQL = `
ALTER TABLE pipeline_run_pin ADD COLUMN source_text TEXT;
`

const PIPELINE_SCHEMA_V3_SQL = `
ALTER TABLE pipeline_node_output ADD COLUMN report_summary TEXT;
`

const PIPELINE_SCHEMA_V4_SQL = `
CREATE TABLE IF NOT EXISTS pipeline_terminal_node_state (
  watcher_id TEXT PRIMARY KEY,
  node_states_json TEXT NOT NULL
);
`

const PIPELINE_MIGRATIONS = [
  PIPELINE_SCHEMA_V1_SQL,
  PIPELINE_SCHEMA_V2_SQL,
  PIPELINE_SCHEMA_V3_SQL,
  PIPELINE_SCHEMA_V4_SQL
]

/** Lazily owns the profile-scoped pipeline persistence database. */
export class PipelineDatabase {
  private readonly scoped: ScopedSqliteDatabase

  constructor(profileDirectory: ScopedDatabaseDirectorySource) {
    this.scoped = new ScopedSqliteDatabase({
      profileDirectory,
      supportsInMemory: true,
      subdirectory: 'fork-heimdall-pipeline',
      filename: 'pipeline.db',
      schemaVersion: PIPELINE_DATABASE_SCHEMA_VERSION,
      migrations: PIPELINE_MIGRATIONS,
      busyTimeoutMs: PIPELINE_DATABASE_BUSY_TIMEOUT_MS,
      missingDirectoryMessage: 'Pipeline persistence requires a profile storage directory',
      readOnlyMessage: 'Pipeline database schema is newer than this build; database is read-only'
    })
  }

  connection(): Database.Database {
    return this.scoped.connection()
  }

  isReadOnly(): boolean {
    return this.scoped.isReadOnly()
  }

  databasePath(): string {
    return this.scoped.databasePath()
  }

  assertWritable(): void {
    this.scoped.assertWritable()
  }

  close(): void {
    this.scoped.close()
  }
}
