import type Database from '../sqlite/sync-database'
import {
  ScopedSqliteDatabase,
  type ScopedDatabaseDirectoryProvider,
  type ScopedDatabaseDirectorySource
} from '../fork-heimdall/scoped-sqlite-database'

export const OBJECTIVE_DATABASE_SCHEMA_VERSION = 5
export const OBJECTIVE_DATABASE_BUSY_TIMEOUT_MS = 5_000

export type ObjectiveProfileDirectoryProvider = ScopedDatabaseDirectoryProvider

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

const OBJECTIVE_SCHEMA_V2_SQL = `
ALTER TABLE plan_node ADD COLUMN amended_at_ms INTEGER;

CREATE TABLE revision_amendment (
  id TEXT PRIMARY KEY,
  watcher_id TEXT NOT NULL,
  revision_id TEXT NOT NULL REFERENCES plan_revision(id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  digest TEXT NOT NULL,
  amended_at_ms INTEGER NOT NULL,
  attestation TEXT NOT NULL,
  touched_task_keys_json TEXT NOT NULL,
  UNIQUE (revision_id, ordinal),
  UNIQUE (revision_id, digest)
);
CREATE INDEX objective_revision_amendment_watcher
  ON revision_amendment (watcher_id, revision_id);
`

const OBJECTIVE_SCHEMA_V3_SQL = `
ALTER TABLE check_attempt ADD COLUMN owner_skip INTEGER NOT NULL DEFAULT 0
  CHECK (owner_skip IN (0, 1));
`

const OBJECTIVE_SCHEMA_V4_SQL = `
ALTER TABLE plan_node ADD COLUMN ordinal INTEGER NOT NULL DEFAULT 0
  CHECK (ordinal >= 0);

UPDATE plan_node
SET ordinal = COALESCE((
  SELECT CAST(item.key AS INTEGER)
  FROM plan_revision AS revision, json_each(revision.payload_json, '$.plan') AS item
  WHERE revision.id = plan_node.revision_id
    AND json_extract(item.value, '$.taskKey') = plan_node.task_key
), 0);

CREATE TABLE objective_dispatch (
  attempt_fingerprint TEXT PRIMARY KEY,
  watcher_id TEXT NOT NULL,
  execution_host_id TEXT NOT NULL,
  revision_id TEXT NOT NULL REFERENCES plan_revision(id),
  task_key TEXT NOT NULL,
  plan_task_digest TEXT NOT NULL,
  dispatch_id TEXT,
  workspace_id TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  lane_task_keys_json TEXT NOT NULL,
  session_node_count INTEGER NOT NULL CHECK (session_node_count BETWEEN 1 AND 5),
  state TEXT NOT NULL CHECK (state IN (
    'running', 'waiting-to-apply', 'applying', 'resolving-conflict',
    'applied', 'failed', 'discarded'
  )),
  commit_sha TEXT,
  applied_commit_sha TEXT,
  report_digest TEXT,
  conflict_paths_json TEXT NOT NULL,
  conflicting_task_keys_json TEXT NOT NULL,
  conflicting_dispatch_ids_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  terminal_handle TEXT,
  setup_state TEXT NOT NULL CHECK (setup_state IN (
    'pending', 'ready', 'cleanup-pending', 'retained', 'cleaned'
  )),
  report_path TEXT,
  report_json TEXT,
  task_json TEXT NOT NULL,
  UNIQUE (watcher_id, dispatch_id)
);
CREATE INDEX objective_dispatch_watcher_created
  ON objective_dispatch (watcher_id, created_at_ms, attempt_fingerprint);
CREATE INDEX objective_dispatch_train
  ON objective_dispatch (watcher_id, state, completed_at_ms, attempt_fingerprint);

CREATE TABLE objective_parallel_state (
  watcher_id TEXT PRIMARY KEY,
  note TEXT,
  updated_at_ms INTEGER NOT NULL
);
`

const OBJECTIVE_SCHEMA_V5_SQL = `
CREATE TABLE plan_patch (
  id TEXT PRIMARY KEY,
  watcher_id TEXT NOT NULL,
  revision_id TEXT NOT NULL REFERENCES plan_revision(id),
  created_by_dispatch_id TEXT NOT NULL,
  repair_ordinal INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'rejected')),
  rejection TEXT,
  created_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER,
  UNIQUE (watcher_id, created_by_dispatch_id)
);
CREATE INDEX objective_plan_patch_watcher
  ON plan_patch (watcher_id, created_at_ms, id);

CREATE TABLE plan_review (
  id TEXT PRIMARY KEY,
  watcher_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('revision', 'patch')),
  target_id TEXT NOT NULL,
  round INTEGER NOT NULL CHECK (round IN (1, 2)),
  dispatch_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('approve', 'revise', 'escalate')),
  report_json TEXT NOT NULL,
  report_digest TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (dispatch_id),
  UNIQUE (target_kind, target_id, round)
);
CREATE INDEX objective_plan_review_watcher
  ON plan_review (watcher_id, created_at_ms, id);

CREATE TABLE gate_attempt (
  id TEXT PRIMARY KEY,
  watcher_id TEXT NOT NULL,
  gate_name TEXT NOT NULL,
  content_identity TEXT NOT NULL,
  execution_host_id TEXT NOT NULL,
  command TEXT NOT NULL,
  exit_code INTEGER,
  timed_out INTEGER,
  stdout_tail TEXT,
  stderr_tail TEXT,
  epoch INTEGER NOT NULL,
  started_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  UNIQUE (watcher_id, gate_name, content_identity)
);
CREATE INDEX objective_gate_attempt_watcher
  ON gate_attempt (watcher_id, started_at_ms, id);
`

const OBJECTIVE_MIGRATIONS = [
  OBJECTIVE_SCHEMA_V1_SQL,
  OBJECTIVE_SCHEMA_V2_SQL,
  OBJECTIVE_SCHEMA_V3_SQL,
  OBJECTIVE_SCHEMA_V4_SQL,
  OBJECTIVE_SCHEMA_V5_SQL
]

/** Lazily owns the profile-scoped objective persistence database. */
export class ObjectiveDatabase {
  private readonly scoped: ScopedSqliteDatabase

  constructor(profileDirectory: ScopedDatabaseDirectorySource) {
    this.scoped = new ScopedSqliteDatabase({
      profileDirectory,
      supportsInMemory: true,
      subdirectory: 'fork-heimdall-objective',
      filename: 'objective.db',
      schemaVersion: OBJECTIVE_DATABASE_SCHEMA_VERSION,
      migrations: OBJECTIVE_MIGRATIONS,
      busyTimeoutMs: OBJECTIVE_DATABASE_BUSY_TIMEOUT_MS,
      missingDirectoryMessage: 'Objective persistence requires a profile storage directory',
      readOnlyMessage: 'Objective database schema is newer than this build; database is read-only'
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
