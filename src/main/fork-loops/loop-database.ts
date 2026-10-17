import { z } from 'zod'
import {
  CheckOutcomeSchema,
  DiffStatsSchema,
  EvaluatorVerdictSchema,
  IterationEndReasonSchema,
  LoopConfigSchema,
  LoopLaunchOverridesSchema,
  LoopPresetSchema,
  LoopStateSchema,
  ParsedMarkerSchema,
  PauseReasonSchema,
  type CheckOutcome,
  type DiffStats,
  type EvaluatorVerdict,
  type IterationEndReason,
  type LoopConfig,
  type LoopErrorCode,
  type LoopPreset,
  type LoopState,
  type ParsedMarker,
  type PauseReason
} from '../../shared/fork-loops/loop-types'
import { isTuiAgent } from '../../shared/tui-agent-config'
import type { TuiAgent } from '../../shared/tui-agent'
import type Database from '../sqlite/sync-database'
import {
  ScopedSqliteDatabase,
  type ScopedDatabaseDirectorySource
} from '../fork-heimdall/scoped-sqlite-database'

export const LOOP_DATABASE_SCHEMA_VERSION = 1
export const LOOP_DATABASE_BUSY_TIMEOUT_MS = 5_000

const LOOP_SCHEMA_V1_SQL = `
CREATE TABLE loops (
  id TEXT PRIMARY KEY,
  worktree_id TEXT NOT NULL,
  workspace_kind TEXT NOT NULL CHECK (workspace_kind IN ('git', 'folder')),
  execution_host_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  agent TEXT NOT NULL,
  launch_overrides_json TEXT,
  preset TEXT NOT NULL CHECK (preset IN ('until-done', 'interval', 'queue')),
  config_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'needs-you', 'paused', 'completed', 'stopped')),
  pause_reason TEXT,
  pause_detail TEXT,
  tab_id TEXT,
  pane_key TEXT,
  pty_id TEXT,
  detached INTEGER NOT NULL DEFAULT 0 CHECK (detached IN (0, 1)),
  iterations_completed INTEGER NOT NULL DEFAULT 0,
  active_ms INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  skipped_ticks INTEGER NOT NULL DEFAULT 0,
  next_iteration_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX loops_worktree ON loops (worktree_id, updated_at);

CREATE TABLE iterations (
  loop_id TEXT NOT NULL REFERENCES loops(id),
  n INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  prompt_sent TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  end_reason TEXT,
  check_json TEXT,
  evaluator_json TEXT,
  diff_json TEXT,
  cost_usd REAL,
  markers_json TEXT,
  output_tail TEXT,
  tree_before TEXT,
  tree_after TEXT,
  protected_path_hits_json TEXT,
  checkpoint_commit TEXT,
  error TEXT,
  PRIMARY KEY (loop_id, n, attempt)
);

CREATE TABLE queue_items (
  loop_id TEXT NOT NULL REFERENCES loops(id),
  id TEXT NOT NULL,
  position INTEGER NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'in-flight', 'done')),
  PRIMARY KEY (loop_id, id)
);

CREATE TABLE steer_notes (
  loop_id TEXT NOT NULL REFERENCES loops(id),
  id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  consumed_by_iteration INTEGER,
  PRIMARY KEY (loop_id, id)
);
`

/** Lazily owns the profile-scoped loop persistence database. */
export class LoopDatabase {
  private readonly scoped: ScopedSqliteDatabase

  constructor(profileDirectory: ScopedDatabaseDirectorySource) {
    this.scoped = new ScopedSqliteDatabase({
      profileDirectory,
      supportsInMemory: true,
      subdirectory: 'fork-loops',
      filename: 'loops.db',
      schemaVersion: LOOP_DATABASE_SCHEMA_VERSION,
      migrations: [LOOP_SCHEMA_V1_SQL],
      busyTimeoutMs: LOOP_DATABASE_BUSY_TIMEOUT_MS,
      missingDirectoryMessage: 'Loop persistence requires a profile storage directory',
      readOnlyMessage: 'Loop database schema is newer than this build; database is read-only'
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

export const ITERATION_OUTPUT_TAIL_LIMIT = 16 * 1024
export const CHECK_OUTPUT_TAIL_LIMIT = 4_000
export const ENDED_LOOP_ITERATIONS_KEPT = 200

export type LoopLaunchOverrides = z.infer<typeof LoopLaunchOverridesSchema>
export type LoopWorkspaceKind = 'git' | 'folder'
export type QueueItemState = 'pending' | 'in-flight' | 'done'

export type StoredLoop = {
  id: string
  worktreeId: string
  workspaceKind: LoopWorkspaceKind
  executionHostId: string
  name: string
  slug: string
  agent: TuiAgent
  launchOverrides: LoopLaunchOverrides | null
  preset: LoopPreset
  config: LoopConfig
  state: LoopState
  pauseReason: PauseReason | null
  pauseDetail: string | null
  tabId: string | null
  paneKey: string | null
  ptyId: string | null
  detached: boolean
  iterationsCompleted: number
  activeMs: number
  costUsd: number | null
  skippedTicks: number
  nextIterationAt: number | null
  createdAt: number
  updatedAt: number
  endedAt: number | null
}

export type LoopInsert = Pick<
  StoredLoop,
  | 'id'
  | 'worktreeId'
  | 'workspaceKind'
  | 'executionHostId'
  | 'name'
  | 'slug'
  | 'agent'
  | 'preset'
  | 'config'
  | 'state'
> &
  Partial<Omit<StoredLoop, 'createdAt' | 'updatedAt' | 'endedAt'>>

export type LoopPatch = Partial<Omit<StoredLoop, 'id' | 'createdAt' | 'updatedAt'>>

export type StoredIteration = {
  loopId: string
  n: number
  attempt: number
  promptSent: string
  startedAt: number
  endedAt: number | null
  endReason: IterationEndReason | null
  check: CheckOutcome | null
  evaluator: EvaluatorVerdict | null
  diff: DiffStats | null
  costUsd: number | null
  markers: ParsedMarker[]
  outputTail: string | null
  treeBefore: string | null
  treeAfter: string | null
  protectedPathHits: string[]
  checkpointCommit: string | null
  error: string | null
}

export type IterationInsert = Pick<StoredIteration, 'n' | 'attempt' | 'promptSent' | 'startedAt'> &
  Partial<Omit<StoredIteration, 'loopId' | 'n' | 'attempt' | 'promptSent' | 'startedAt'>>

export type IterationPatch = Partial<
  Omit<StoredIteration, 'loopId' | 'n' | 'attempt' | 'startedAt'>
>

export type QueueItem = {
  loopId: string
  id: string
  position: number
  body: string
  state: QueueItemState
}

export type SteerNote = {
  loopId: string
  id: string
  body: string
  createdAt: number
  consumedByIteration: number | null
}

/** Store failure carrying a wire-stable `LoopErrorCode`. */
export class LoopStoreError extends Error {
  readonly code: LoopErrorCode

  constructor(code: LoopErrorCode, message: string) {
    super(message)
    this.name = 'LoopStoreError'
    this.code = code
  }
}

const LoopRowSchema = z.object({
  id: z.string(),
  worktree_id: z.string(),
  workspace_kind: z.enum(['git', 'folder']),
  execution_host_id: z.string(),
  name: z.string(),
  slug: z.string(),
  agent: z.string(),
  launch_overrides_json: z.string().nullable(),
  preset: LoopPresetSchema,
  config_json: z.string(),
  state: LoopStateSchema,
  pause_reason: PauseReasonSchema.nullable(),
  pause_detail: z.string().nullable(),
  tab_id: z.string().nullable(),
  pane_key: z.string().nullable(),
  pty_id: z.string().nullable(),
  detached: z.number(),
  iterations_completed: z.number(),
  active_ms: z.number(),
  cost_usd: z.number().nullable(),
  skipped_ticks: z.number(),
  next_iteration_at: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  ended_at: z.number().nullable()
})

const IterationRowSchema = z.object({
  loop_id: z.string(),
  n: z.number(),
  attempt: z.number(),
  prompt_sent: z.string(),
  started_at: z.number(),
  ended_at: z.number().nullable(),
  end_reason: IterationEndReasonSchema.nullable(),
  check_json: z.string().nullable(),
  evaluator_json: z.string().nullable(),
  diff_json: z.string().nullable(),
  cost_usd: z.number().nullable(),
  markers_json: z.string().nullable(),
  output_tail: z.string().nullable(),
  tree_before: z.string().nullable(),
  tree_after: z.string().nullable(),
  protected_path_hits_json: z.string().nullable(),
  checkpoint_commit: z.string().nullable(),
  error: z.string().nullable()
})

const QueueRowSchema = z.object({
  loop_id: z.string(),
  id: z.string(),
  position: z.number(),
  body: z.string(),
  state: z.enum(['pending', 'in-flight', 'done'])
})

const SteerNoteRowSchema = z.object({
  loop_id: z.string(),
  id: z.string(),
  body: z.string(),
  created_at: z.number(),
  consumed_by_iteration: z.number().nullable()
})

export const LOOP_COLUMNS = `id, worktree_id, workspace_kind, execution_host_id, name, slug, agent,
  launch_overrides_json, preset, config_json, state, pause_reason, pause_detail, tab_id, pane_key,
  pty_id, detached, iterations_completed, active_ms, cost_usd, skipped_ticks, next_iteration_at,
  created_at, updated_at, ended_at`

export const ITERATION_COLUMNS = `loop_id, n, attempt, prompt_sent, started_at, ended_at, end_reason,
  check_json, evaluator_json, diff_json, cost_usd, markers_json, output_tail, tree_before, tree_after,
  protected_path_hits_json, checkpoint_commit, error`

export const QUEUE_COLUMNS = 'loop_id, id, position, body, state'
export const STEER_NOTE_COLUMNS = 'loop_id, id, body, created_at, consumed_by_iteration'

export function nullableJson(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value)
}

export function pick<T>(next: T | undefined, current: T): T {
  return next === undefined ? current : next
}

export function assign<V>(
  out: [string, Database.BindValue][],
  column: string,
  value: V | undefined,
  encode: (value: V) => Database.BindValue
): void {
  if (value !== undefined) {
    out.push([column, encode(value)])
  }
}

export function identity<V extends Database.BindValue>(value: V): V {
  return value
}

export function patchAssignments(patch: LoopPatch): [string, Database.BindValue][] {
  const out: [string, Database.BindValue][] = []
  assign(out, 'worktree_id', patch.worktreeId, identity)
  assign(out, 'workspace_kind', patch.workspaceKind, identity)
  assign(out, 'execution_host_id', patch.executionHostId, identity)
  assign(out, 'name', patch.name, identity)
  assign(out, 'slug', patch.slug, identity)
  assign(out, 'agent', patch.agent, identity)
  assign(out, 'launch_overrides_json', patch.launchOverrides, nullableJson)
  assign(out, 'preset', patch.preset, identity)
  assign(out, 'config_json', patch.config, (value) => JSON.stringify(value))
  assign(out, 'state', patch.state, identity)
  assign(out, 'pause_reason', patch.pauseReason, identity)
  assign(out, 'pause_detail', patch.pauseDetail, identity)
  assign(out, 'tab_id', patch.tabId, identity)
  assign(out, 'pane_key', patch.paneKey, identity)
  assign(out, 'pty_id', patch.ptyId, identity)
  assign(out, 'detached', patch.detached, (value) => (value ? 1 : 0))
  assign(out, 'iterations_completed', patch.iterationsCompleted, identity)
  assign(out, 'active_ms', patch.activeMs, identity)
  assign(out, 'cost_usd', patch.costUsd, identity)
  assign(out, 'skipped_ticks', patch.skippedTicks, identity)
  assign(out, 'next_iteration_at', patch.nextIterationAt, identity)
  assign(out, 'ended_at', patch.endedAt, identity)
  return out
}

export function parseJson<T>(schema: z.ZodType<T>, text: string): T {
  return schema.parse(JSON.parse(text))
}

export function tail(text: string, limit: number): string {
  return text.length > limit ? text.slice(text.length - limit) : text
}

export function boundCheck(check: CheckOutcome): CheckOutcome {
  return {
    ...check,
    stdoutTail: tail(check.stdoutTail, CHECK_OUTPUT_TAIL_LIMIT),
    stderrTail: tail(check.stderrTail, CHECK_OUTPUT_TAIL_LIMIT)
  }
}

export function toStoredLoop(raw: unknown): StoredLoop {
  const row = LoopRowSchema.parse(raw)
  if (!isTuiAgent(row.agent)) {
    throw new Error(`Loop ${row.id} has unknown agent "${row.agent}"`)
  }
  return {
    id: row.id,
    worktreeId: row.worktree_id,
    workspaceKind: row.workspace_kind,
    executionHostId: row.execution_host_id,
    name: row.name,
    slug: row.slug,
    agent: row.agent,
    launchOverrides:
      row.launch_overrides_json === null
        ? null
        : parseJson(LoopLaunchOverridesSchema, row.launch_overrides_json),
    preset: row.preset,
    config: parseJson(LoopConfigSchema, row.config_json),
    state: row.state,
    pauseReason: row.pause_reason,
    pauseDetail: row.pause_detail,
    tabId: row.tab_id,
    paneKey: row.pane_key,
    ptyId: row.pty_id,
    detached: row.detached === 1,
    iterationsCompleted: row.iterations_completed,
    activeMs: row.active_ms,
    costUsd: row.cost_usd,
    skippedTicks: row.skipped_ticks,
    nextIterationAt: row.next_iteration_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at
  }
}

export function toStoredIteration(raw: unknown): StoredIteration {
  const row = IterationRowSchema.parse(raw)
  return {
    loopId: row.loop_id,
    n: row.n,
    attempt: row.attempt,
    promptSent: row.prompt_sent,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
    check: row.check_json === null ? null : parseJson(CheckOutcomeSchema, row.check_json),
    evaluator:
      row.evaluator_json === null ? null : parseJson(EvaluatorVerdictSchema, row.evaluator_json),
    diff: row.diff_json === null ? null : parseJson(DiffStatsSchema, row.diff_json),
    costUsd: row.cost_usd,
    markers:
      row.markers_json === null ? [] : parseJson(z.array(ParsedMarkerSchema), row.markers_json),
    outputTail: row.output_tail,
    treeBefore: row.tree_before,
    treeAfter: row.tree_after,
    protectedPathHits:
      row.protected_path_hits_json === null
        ? []
        : parseJson(z.array(z.string()), row.protected_path_hits_json),
    checkpointCommit: row.checkpoint_commit,
    error: row.error
  }
}

export function toQueueItem(raw: unknown): QueueItem {
  const row = QueueRowSchema.parse(raw)
  return {
    loopId: row.loop_id,
    id: row.id,
    position: row.position,
    body: row.body,
    state: row.state
  }
}

export function toSteerNote(raw: unknown): SteerNote {
  const row = SteerNoteRowSchema.parse(raw)
  return {
    loopId: row.loop_id,
    id: row.id,
    body: row.body,
    createdAt: row.created_at,
    consumedByIteration: row.consumed_by_iteration
  }
}
