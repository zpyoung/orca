import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { OBJECTIVE_DATABASE_SCHEMA_VERSION, ObjectiveDatabase } from './objective-database'
import { ObjectiveStore } from './objective-store'

const WATCHER_ID = 'watcher-objective-1'
let root: string
const opened: ObjectiveDatabase[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-objective-database-'))
})

afterEach(() => {
  for (const item of opened) {
    item.close()
  }
  opened.length = 0
  rmSync(root, { recursive: true, force: true })
})

describe('Objective database initialization', () => {
  it('creates only the current objective tables with durable connection settings and POSIX hardening', () => {
    const disk = new ObjectiveDatabase(root)
    opened.push(disk)
    const connection = disk.connection()
    const tables = connection
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as unknown as { name: string }[]
    // sorted so a future table only needs adding here, not placed correctly against SQLite's
    // own ORDER BY name collation (which sorts review_verdict before revision_amendment)
    expect(tables.map(({ name }) => name)).toEqual(
      [
        'acceptance_criterion',
        'check_attempt',
        'landing_evidence',
        'objective_dispatch',
        'objective_parallel_state',
        'plan_node',
        'plan_revision',
        'revision_amendment',
        'review_verdict'
      ].sort()
    )
    expect(connection.pragma('user_version', { simple: true })).toBe(
      OBJECTIVE_DATABASE_SCHEMA_VERSION
    )
    expect(connection.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(connection.pragma('busy_timeout', { simple: true })).toBe(5_000)
    expect(connection.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(connection.pragma('synchronous', { simple: true })).toBe(2)
    if (process.platform !== 'win32') {
      expect(statSync(disk.databasePath()).mode & 0o777).toBe(0o600)
    }
  })

  it('opens a future schema read-only without downgrading it', () => {
    const path = join(root, 'fork-heimdall-objective', 'objective.db')
    mkdirSync(join(root, 'fork-heimdall-objective'), { recursive: true })
    const future = new Database(path)
    future.pragma(`user_version = ${OBJECTIVE_DATABASE_SCHEMA_VERSION + 1}`)
    future.close()
    const disk = new ObjectiveDatabase(root)
    opened.push(disk)
    const futureStore = new ObjectiveStore(disk)

    expect(disk.isReadOnly()).toBe(true)
    expect(disk.connection().pragma('user_version', { simple: true })).toBe(
      OBJECTIVE_DATABASE_SCHEMA_VERSION + 1
    )
    expect(() => futureStore.purge(WATCHER_ID)).toThrow(/read-only/)
  })

  it('migrates a v1 database to the current schema without losing data', () => {
    const path = join(root, 'fork-heimdall-objective', 'objective.db')
    mkdirSync(join(root, 'fork-heimdall-objective'), { recursive: true })
    const legacy = new Database(path)
    legacy.exec(`
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
      CREATE TABLE acceptance_criterion (
        id TEXT PRIMARY KEY,
        watcher_id TEXT NOT NULL,
        revision_id TEXT NOT NULL REFERENCES plan_revision(id),
        task_key TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        body TEXT NOT NULL,
        shell_checkable INTEGER NOT NULL CHECK (shell_checkable IN (0, 1)),
        check_command TEXT,
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
      INSERT INTO plan_revision VALUES (
        'revision-legacy', 'watcher-legacy', 1, 'approved', '{"plan":[]}', 'digest-legacy',
        'planner-legacy', 1, 1
      );
      INSERT INTO plan_node VALUES (
        'node-legacy', 'watcher-legacy', 'revision-legacy', 'task-legacy', 'Legacy title',
        'Legacy spec', '[]', NULL, NULL, NULL
      );
      INSERT INTO acceptance_criterion VALUES (
        'criterion-legacy', 'watcher-legacy', 'revision-legacy', 'task-legacy', 0,
        'Legacy criterion', 1, 'true'
      );
      INSERT INTO check_attempt VALUES (
        'check-legacy', 'watcher-legacy', 'criterion-legacy', 'content-legacy', 'local',
        'true', 0, 0, '', '', 1, 1, 2
      );
      PRAGMA user_version = 1;
    `)
    legacy.close()

    const migrated = new ObjectiveDatabase(root)
    opened.push(migrated)
    const connection = migrated.connection()
    expect(
      connection.prepare('SELECT amended_at_ms FROM plan_node WHERE id = ?').get('node-legacy')
    ).toEqual({ amended_at_ms: null })
    expect(
      connection
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'revision_amendment'"
        )
        .get()
    ).toBeDefined()
    expect(
      connection.prepare('SELECT owner_skip FROM check_attempt WHERE id = ?').get('check-legacy')
    ).toEqual({ owner_skip: 0 })
    expect(connection.pragma('user_version', { simple: true })).toBe(
      OBJECTIVE_DATABASE_SCHEMA_VERSION
    )
  })
})
