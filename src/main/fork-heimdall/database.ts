import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from '../sqlite/sync-database'
import { hardenSqliteDatabaseFiles } from '../sqlite/harden-database-files'

export const HEIMDALL_DATABASE_SCHEMA_VERSION = 4
export const HEIMDALL_DATABASE_BUSY_TIMEOUT_MS = 5_000

export type HeimdallProfileDirectoryProvider = {
  getProfileStorageDirectory(): string
}

type ProfileDirectorySource = string | (() => string) | HeimdallProfileDirectoryProvider

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

/** Lazily owns the single profile-scoped Heimdall registry database. */
export class HeimdallDatabase {
  private opened: Database.Database | null = null
  private openedReadOnly = false
  private openedPath: string | null = null

  constructor(private readonly profileDirectory: ProfileDirectorySource) {}

  connection(): Database.Database {
    if (this.opened) {
      return this.opened
    }

    const databasePath = this.resolveDatabasePath()
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
    const probe = new Database(databasePath, { timeout: HEIMDALL_DATABASE_BUSY_TIMEOUT_MS })
    let storedVersion: number
    try {
      storedVersion = Number(probe.pragma('user_version', { simple: true }) ?? 0)
    } catch (error) {
      probe.close()
      throw error
    }
    if (storedVersion > HEIMDALL_DATABASE_SCHEMA_VERSION) {
      probe.close()
      const readOnly = new Database(databasePath, {
        readonly: true,
        fileMustExist: true,
        timeout: HEIMDALL_DATABASE_BUSY_TIMEOUT_MS
      })
      this.opened = readOnly
      this.openedReadOnly = true
      this.openedPath = databasePath
      return readOnly
    }

    let probeOpen = true
    let transferred = false
    try {
      this.configure(probe)
      const initialization = this.createSchema(probe, storedVersion)
      if (initialization === 'future-schema') {
        probe.close()
        probeOpen = false
        const readOnly = new Database(databasePath, {
          readonly: true,
          fileMustExist: true,
          timeout: HEIMDALL_DATABASE_BUSY_TIMEOUT_MS
        })
        this.opened = readOnly
        this.openedReadOnly = true
        this.openedPath = databasePath
        transferred = true
        return readOnly
      }
      hardenSqliteDatabaseFiles(databasePath)
      this.opened = probe
      this.openedReadOnly = false
      this.openedPath = databasePath
      transferred = true
      return probe
    } finally {
      if (!transferred && probeOpen) {
        probe.close()
      }
    }
  }

  isReadOnly(): boolean {
    this.connection()
    return this.openedReadOnly
  }

  databasePath(): string {
    return this.openedPath ?? this.resolveDatabasePath()
  }

  assertWritable(): void {
    if (this.isReadOnly()) {
      throw new Error('Heimdall database schema is newer than this build; database is read-only')
    }
  }

  close(): void {
    this.opened?.close()
    this.opened = null
    this.openedReadOnly = false
    this.openedPath = null
  }

  private resolveDatabasePath(): string {
    const profileDirectory =
      typeof this.profileDirectory === 'string'
        ? this.profileDirectory
        : typeof this.profileDirectory === 'function'
          ? this.profileDirectory()
          : this.profileDirectory.getProfileStorageDirectory()
    if (!profileDirectory) {
      throw new Error('Heimdall requires a profile storage directory')
    }
    return join(profileDirectory, 'fork-heimdall', 'heimdall.db')
  }

  private configure(database: Database.Database): void {
    database.pragma('journal_mode = WAL')
    database.pragma(`busy_timeout = ${HEIMDALL_DATABASE_BUSY_TIMEOUT_MS}`)
    database.pragma('foreign_keys = ON')
    database.pragma('synchronous = FULL')
  }

  /**
   * The initial version probe chooses the no-write future-schema path. A second process can still
   * initialize or upgrade the fresh file before this connection obtains its writer lock, so the
   * version that authorizes DDL and the version write must be read again inside that transaction.
   */
  private createSchema(
    database: Database.Database,
    storedVersion: number
  ): 'writable' | 'future-schema' {
    if (storedVersion >= HEIMDALL_DATABASE_SCHEMA_VERSION) {
      return 'writable'
    }

    database.exec('BEGIN IMMEDIATE')
    try {
      const lockedVersion = Number(database.pragma('user_version', { simple: true }) ?? 0)
      if (lockedVersion > HEIMDALL_DATABASE_SCHEMA_VERSION) {
        database.exec('ROLLBACK')
        return 'future-schema'
      }
      if (lockedVersion < 1) {
        database.exec(HEIMDALL_SCHEMA_V1_SQL)
      }
      if (lockedVersion < 2) {
        database.exec(HEIMDALL_SCHEMA_V2_SQL)
      }
      if (lockedVersion < 3) {
        database.exec(HEIMDALL_SCHEMA_V3_SQL)
      }
      if (lockedVersion < 4) {
        database.exec(HEIMDALL_SCHEMA_V4_SQL)
      }
      if (lockedVersion < HEIMDALL_DATABASE_SCHEMA_VERSION) {
        database.pragma(`user_version = ${HEIMDALL_DATABASE_SCHEMA_VERSION}`)
      }
      database.exec('COMMIT')
      return 'writable'
    } catch (error) {
      if (database.isTransaction) {
        database.exec('ROLLBACK')
      }
      throw error
    }
  }
}
