import { ensurePipelineSideTables } from '../fork-heimdall-pipeline/pipeline-enrollment-table'
import type Database from '../sqlite/sync-database'
import {
  ScopedSqliteDatabase,
  type ScopedDatabaseDirectoryProvider,
  type ScopedDatabaseDirectorySource
} from './scoped-sqlite-database'

export const HEIMDALL_DATABASE_SCHEMA_VERSION = 4
export const HEIMDALL_DATABASE_BUSY_TIMEOUT_MS = 5_000

export type HeimdallProfileDirectoryProvider = ScopedDatabaseDirectoryProvider

const HEIMDALL_SCHEMA_V1_SQL = `
CREATE TABLE heimdall_enrollment (
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
  terminal_at_ms INTEGER
);
CREATE UNIQUE INDEX heimdall_enrollment_live_workspace
  ON heimdall_enrollment (workspace_key)
  WHERE terminal_at_ms IS NULL;

CREATE TABLE heimdall_ledger (
  watcher_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  at_ms INTEGER NOT NULL,
  class TEXT NOT NULL CHECK (class IN ('fact', 'observation')),
  kind TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (
    origin IN ('owner', 'client') AND (origin = 'owner' OR kind = 'client-observation')
  ),
  resolved INTEGER NOT NULL CHECK (resolved IN (0, 1)),
  entry_json TEXT NOT NULL,
  PRIMARY KEY (watcher_id, seq)
);
CREATE UNIQUE INDEX heimdall_ledger_attempt_resolution
  ON heimdall_ledger (watcher_id, json_extract(entry_json, '$.attemptId'))
  WHERE kind = 'attempt-resolved';
CREATE UNIQUE INDEX heimdall_ledger_terminal
  ON heimdall_ledger (watcher_id)
  WHERE kind = 'terminal';
CREATE INDEX heimdall_ledger_retention
  ON heimdall_ledger (watcher_id, class, resolved, seq);

CREATE TABLE heimdall_tick_trace (
  watcher_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
  trace_json TEXT NOT NULL,
  PRIMARY KEY (watcher_id, seq)
);

CREATE TABLE heimdall_terminal_summary (
  watcher_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  terminal_state TEXT NOT NULL,
  reason TEXT NOT NULL,
  totals_json TEXT NOT NULL,
  at_ms INTEGER NOT NULL
);
`

const HEIMDALL_SCHEMA_V2_SQL = `
ALTER TABLE heimdall_enrollment
  ADD COLUMN paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1));
ALTER TABLE heimdall_enrollment
  ADD COLUMN command_revision INTEGER NOT NULL DEFAULT 0 CHECK (command_revision >= 0);
`

const HEIMDALL_SCHEMA_V3_SQL = `
ALTER TABLE heimdall_enrollment
  ADD COLUMN owner_json TEXT;
`
const HEIMDALL_SCHEMA_V4_SQL = `
CREATE TABLE heimdall_pending_kind_purge (
  watcher_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL
);
`

const HEIMDALL_MIGRATIONS = [
  HEIMDALL_SCHEMA_V1_SQL,
  HEIMDALL_SCHEMA_V2_SQL,
  HEIMDALL_SCHEMA_V3_SQL,
  HEIMDALL_SCHEMA_V4_SQL
]

/** Lazily owns the single profile-scoped Heimdall registry database. */
export class HeimdallDatabase {
  private readonly scoped: ScopedSqliteDatabase
  private pipelineSideTablesEnsured = false

  constructor(profileDirectory: ScopedDatabaseDirectorySource) {
    this.scoped = new ScopedSqliteDatabase({
      profileDirectory,
      supportsInMemory: false,
      subdirectory: 'fork-heimdall',
      filename: 'heimdall.db',
      schemaVersion: HEIMDALL_DATABASE_SCHEMA_VERSION,
      migrations: HEIMDALL_MIGRATIONS,
      busyTimeoutMs: HEIMDALL_DATABASE_BUSY_TIMEOUT_MS,
      missingDirectoryMessage: 'Heimdall requires a profile storage directory',
      readOnlyMessage: 'Heimdall database schema is newer than this build; database is read-only'
    })
  }

  connection(): Database.Database {
    const connection = this.scoped.connection()
    if (!this.pipelineSideTablesEnsured && !this.scoped.isReadOnly()) {
      ensurePipelineSideTables(connection)
      this.pipelineSideTablesEnsured = true
    }
    return connection
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
    this.pipelineSideTablesEnsured = false
  }
}
