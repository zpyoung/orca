import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from '../sqlite/sync-database'
import { hardenSqliteDatabaseFiles } from '../sqlite/harden-database-files'

export const OBJECTIVE_DATABASE_SCHEMA_VERSION = 1
export const OBJECTIVE_DATABASE_BUSY_TIMEOUT_MS = 5_000

export type ObjectiveProfileDirectoryProvider = {
  getProfileStorageDirectory(): string
}

type ProfileDirectorySource = string | (() => string) | ObjectiveProfileDirectoryProvider

const OBJECTIVE_SCHEMA_V1_SQL = `
CREATE TABLE plan_revision (
  id TEXT PRIMARY KEY,
  watcher_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'rejected', 'superseded')),
  payload_json TEXT NOT NULL,
  digest TEXT NOT NULL,
  created_by_dispatch_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  approved_at_ms INTEGER,
  UNIQUE (watcher_id, revision_number)
);
CREATE UNIQUE INDEX objective_plan_revision_draft
  ON plan_revision (watcher_id)
  WHERE status = 'draft';

CREATE TABLE plan_node (
  id TEXT PRIMARY KEY,
  watcher_id TEXT NOT NULL,
  revision_id TEXT NOT NULL REFERENCES plan_revision(id),
  task_key TEXT NOT NULL,
  title TEXT NOT NULL,
  spec TEXT NOT NULL,
  deps_json TEXT NOT NULL,
  orchestration_task_id TEXT,
  dispatch_id TEXT,
  dispatched_at_ms INTEGER,
  UNIQUE (revision_id, task_key)
);
CREATE INDEX objective_plan_node_watcher_task
  ON plan_node (watcher_id, task_key);

CREATE TABLE acceptance_criterion (
  id TEXT PRIMARY KEY,
  watcher_id TEXT NOT NULL,
  revision_id TEXT NOT NULL REFERENCES plan_revision(id),
  task_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  body TEXT NOT NULL,
  shell_checkable INTEGER NOT NULL CHECK (shell_checkable IN (0, 1)),
  check_command TEXT,
  CHECK ((shell_checkable = 1 AND check_command IS NOT NULL) OR
         (shell_checkable = 0 AND check_command IS NULL)),
  UNIQUE (revision_id, task_key, ordinal)
);

CREATE TABLE check_attempt (
  id TEXT PRIMARY KEY,
  watcher_id TEXT NOT NULL,
  criterion_id TEXT NOT NULL REFERENCES acceptance_criterion(id),
  content_identity TEXT NOT NULL,
  execution_host_id TEXT NOT NULL,
  command TEXT NOT NULL,
  exit_code INTEGER,
  timed_out INTEGER NOT NULL CHECK (timed_out IN (0, 1)),
  stdout_tail TEXT NOT NULL,
  stderr_tail TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  started_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  UNIQUE (criterion_id, content_identity)
);

CREATE TABLE review_verdict (
  id TEXT PRIMARY KEY,
  watcher_id TEXT NOT NULL,
  revision_id TEXT NOT NULL REFERENCES plan_revision(id),
  dispatch_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('reviewer', 'integrator')),
  content_identity TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('approve', 'block')),
  criteria_results_json TEXT NOT NULL,
  report_digest TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (dispatch_id)
);

CREATE TABLE landing_evidence (
  id TEXT PRIMARY KEY,
  watcher_id TEXT NOT NULL,
  rung TEXT NOT NULL CHECK (rung IN ('files-on-disk', 'committed-local-branch', 'pushed-ref', 'hosted-review', 'merged')),
  content_identity TEXT NOT NULL,
  attempt_fingerprint TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (watcher_id, rung, content_identity)
);
`

/** Lazily owns the profile-scoped objective persistence database. */
export class ObjectiveDatabase {
  private opened: Database.Database | null = null
  private openedReadOnly = false
  private openedPath: string | null = null

  constructor(private readonly profileDirectory: ProfileDirectorySource) {}

  connection(): Database.Database {
    if (this.opened) {
      return this.opened
    }

    const databasePath = this.resolveDatabasePath()
    if (databasePath !== ':memory:') {
      mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
    }
    const probe = new Database(databasePath, { timeout: OBJECTIVE_DATABASE_BUSY_TIMEOUT_MS })
    let storedVersion: number
    try {
      storedVersion = Number(probe.pragma('user_version', { simple: true }) ?? 0)
    } catch (error) {
      probe.close()
      throw error
    }
    if (storedVersion > OBJECTIVE_DATABASE_SCHEMA_VERSION) {
      probe.close()
      const readOnly = new Database(databasePath, {
        readonly: true,
        fileMustExist: true,
        timeout: OBJECTIVE_DATABASE_BUSY_TIMEOUT_MS
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
          timeout: OBJECTIVE_DATABASE_BUSY_TIMEOUT_MS
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
      throw new Error('Objective database schema is newer than this build; database is read-only')
    }
  }

  close(): void {
    this.opened?.close()
    this.opened = null
    this.openedReadOnly = false
    this.openedPath = null
  }

  private resolveDatabasePath(): string {
    if (this.profileDirectory === ':memory:') {
      return ':memory:'
    }
    const profileDirectory =
      typeof this.profileDirectory === 'string'
        ? this.profileDirectory
        : typeof this.profileDirectory === 'function'
          ? this.profileDirectory()
          : this.profileDirectory.getProfileStorageDirectory()
    if (!profileDirectory) {
      throw new Error('Objective persistence requires a profile storage directory')
    }
    return join(profileDirectory, 'fork-heimdall-objective', 'objective.db')
  }

  private configure(database: Database.Database): void {
    database.pragma('journal_mode = WAL')
    database.pragma(`busy_timeout = ${OBJECTIVE_DATABASE_BUSY_TIMEOUT_MS}`)
    database.pragma('foreign_keys = ON')
    database.pragma('synchronous = FULL')
  }

  private createSchema(
    database: Database.Database,
    storedVersion: number
  ): 'writable' | 'future-schema' {
    if (storedVersion >= OBJECTIVE_DATABASE_SCHEMA_VERSION) {
      return 'writable'
    }

    database.exec('BEGIN IMMEDIATE')
    try {
      const lockedVersion = Number(database.pragma('user_version', { simple: true }) ?? 0)
      if (lockedVersion > OBJECTIVE_DATABASE_SCHEMA_VERSION) {
        database.exec('ROLLBACK')
        return 'future-schema'
      }
      if (lockedVersion < 1) {
        database.exec(OBJECTIVE_SCHEMA_V1_SQL)
      }
      if (lockedVersion < OBJECTIVE_DATABASE_SCHEMA_VERSION) {
        database.pragma(`user_version = ${OBJECTIVE_DATABASE_SCHEMA_VERSION}`)
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
