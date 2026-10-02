import {
  PipelinePinSchema,
  type PipelinePin
} from '../../shared/fork-heimdall-pipeline/pipeline-pin'
import {
  PipelineSourceSnapshotSchema,
  type PipelineSourceSnapshot
} from '../../shared/fork-heimdall-pipeline/pipeline-source'
import {
  PipelineTerminalNodeStatesSchema,
  type PipelineStoreFacts,
  type PipelineTerminalNodeState
} from '../../shared/fork-heimdall-pipeline/store-facts'
import type Database from '../sqlite/sync-database'
import type { SqliteStatement } from '../sqlite/sync-database'
import { withImmediateTransaction } from '../fork-heimdall/transaction-scope'
import type { PipelineDatabase } from './pipeline-database'
import {
  parsePipelineStoreJson as parseJson,
  pipelineStoreRows as allRows,
  readPipelineFacts,
  type PipelineCompositeRow as CompositeRow
} from './pipeline-store-read'

type PipelineComposite = PipelineStoreFacts['composites'][number]
type PipelineMergeProgress = PipelineStoreFacts['mergeProgress'][number]
type PipelineSwarmExpansion = PipelineStoreFacts['swarmExpansions'][number]

export type RecordNodeOutputArgs = {
  watcherId: string
  instanceId: string
  epoch: number
  attempt: number
  outputs: Record<string, unknown>
  reportSha256: string | null
  reportSummary?: string
  nowMs: number
}

export type RecordDispatchArgs = {
  watcherId: string
  instanceId: string
  epoch: number
  attempt: number
  dispatchId: string
  workspaceId: string | null
  terminalHandle: string | null
  reportPath: string
  dispatchedAtMs: number
}

export type RecordAttemptBaselineArgs = {
  watcherId: string
  attemptFingerprint: string
  workspacePath: string
  digest: unknown
}

export type RecordSwarmExpansionArgs = {
  watcherId: string
  swarmId: string
  epoch: number
  tasks: PipelineSwarmExpansion['tasks']
  warnings: PipelineSwarmExpansion['warnings']
  baseCommit: string | null
}

export type RecordChildWorktreeArgs = {
  watcherId: string
  instanceId: string
  epoch: number
  worktreeId: string
  setupState: string
}

export type SetMergeProgressArgs = {
  watcherId: string
  mergeId: string
  epoch: number
  childInstanceId: string
  state: PipelineMergeProgress['state']
  commitSha?: string | null
  appliedCommitSha?: string | null
  conflict?: PipelineMergeProgress['conflict']
}

export type RecordCompositeArgs = Omit<PipelineComposite, 'instanceId' | 'epoch'> & {
  watcherId: string
  instanceId: string
  epoch: number
}

type RunPinRow = {
  ref: string
  scope: string
  pipeline_id: string
  content_hash: string
  document_version: number
  run_number: number
}

type AttemptBaselineRow = { workspace_path: string; digest_json: string }
type DispatchAttemptKeyRow = { instance_id: string; epoch: number; attempt: number }
type AttemptFingerprintRow = { attempt_fingerprint: string }

const PIPELINE_TABLES = [
  'pipeline_run_pin',
  'pipeline_node_output',
  'pipeline_terminal_node_state',
  'pipeline_dispatch',
  'pipeline_attempt_baseline',
  'pipeline_swarm_expansion',
  'pipeline_child_worktree',
  'pipeline_merge_progress',
  'pipeline_composite'
] as const

function oneRow<T>(
  statement: SqliteStatement,
  ...params: readonly Database.BindValue[]
): T | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: node:sqlite types each row as Record<string, SQLOutputValue>; call sites match T to their selected columns.
  return statement.get(...params) as T | undefined
}

function serializeJson(value: unknown, field: string): string {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) {
    throw new TypeError(`Pipeline ${field} must be JSON serializable`)
  }
  return serialized
}

function runPipelineMutation<T>(
  database: PipelineDatabase,
  operation: (db: Database.Database) => T
): T {
  database.assertWritable()
  const db: Database.Database = database.connection()
  return withImmediateTransaction(db, () => operation(db))
}

/** Synchronous persistence for pipeline run facts, keyed by watcher and node attempt. */
export class PipelineStore {
  constructor(private readonly database: PipelineDatabase) {}

  recordRunPin(
    watcherId: string,
    pin: PipelinePin,
    nowMs: number,
    source?: PipelineSourceSnapshot
  ): { runNumber: number } {
    return runPipelineMutation(this.database, (db) => {
      const existing = oneRow<{ run_number: number }>(
        db.prepare('SELECT run_number FROM pipeline_run_pin WHERE watcher_id = ?'),
        watcherId
      )
      if (existing) {
        return { runNumber: existing.run_number }
      }
      const sourceText =
        source === undefined ? null : PipelineSourceSnapshotSchema.parse(source).sourceText

      const maximum = oneRow<{ maximum: number | null }>(
        db.prepare('SELECT MAX(run_number) AS maximum FROM pipeline_run_pin WHERE ref = ?'),
        pin.ref
      )
      const runNumber = (maximum?.maximum ?? 0) + 1
      db.prepare(`INSERT INTO pipeline_run_pin (
        watcher_id, ref, scope, pipeline_id, content_hash, document_version, run_number, recorded_at_ms,
        source_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        watcherId,
        pin.ref,
        pin.scope,
        pin.id,
        pin.contentHash,
        pin.documentVersion,
        runNumber,
        nowMs,
        sourceText
      )
      return { runNumber }
    })
  }

  runPin(watcherId: string): (PipelinePin & { runNumber: number }) | null {
    const row = oneRow<RunPinRow>(
      this.database.connection().prepare(`SELECT ref, scope, pipeline_id, content_hash,
        document_version, run_number FROM pipeline_run_pin WHERE watcher_id = ?`),
      watcherId
    )
    if (!row) {
      return null
    }
    const pin = PipelinePinSchema.parse({
      ref: row.ref,
      scope: row.scope,
      id: row.pipeline_id,
      contentHash: row.content_hash,
      documentVersion: row.document_version
    })
    return { ...pin, runNumber: row.run_number }
  }

  runSource(watcherId: string): PipelineSourceSnapshot | null {
    const row = oneRow<{ source_text: string | null }>(
      this.database
        .connection()
        .prepare('SELECT source_text FROM pipeline_run_pin WHERE watcher_id = ?'),
      watcherId
    )
    if (!row || row.source_text === null) {
      return null
    }
    return PipelineSourceSnapshotSchema.parse({ sourceText: row.source_text })
  }

  liveRunsForRef(
    ref: string,
    liveWatcherIds: ReadonlySet<string>
  ): { watcherId: string; runNumber: number; contentHash: string }[] {
    const rows = allRows<{ watcher_id: string; run_number: number; content_hash: string }>(
      this.database.connection().prepare(`SELECT watcher_id, run_number, content_hash
        FROM pipeline_run_pin WHERE ref = ? ORDER BY run_number, watcher_id`),
      ref
    )
    return rows.flatMap((row) =>
      liveWatcherIds.has(row.watcher_id)
        ? [{ watcherId: row.watcher_id, runNumber: row.run_number, contentHash: row.content_hash }]
        : []
    )
  }

  recordNodeOutput(args: RecordNodeOutputArgs): void {
    runPipelineMutation(this.database, (db) => {
      db.prepare(`INSERT INTO pipeline_node_output (
        watcher_id, instance_id, epoch, attempt, outputs_json, report_sha256, report_summary,
        recorded_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (watcher_id, instance_id, epoch, attempt) DO UPDATE SET
        outputs_json = excluded.outputs_json,
        report_sha256 = excluded.report_sha256,
        report_summary = excluded.report_summary,
        recorded_at_ms = excluded.recorded_at_ms`).run(
        args.watcherId,
        args.instanceId,
        args.epoch,
        args.attempt,
        serializeJson(args.outputs, 'node outputs'),
        args.reportSha256,
        args.reportSummary ?? null,
        args.nowMs
      )
    })
  }

  recordTerminalNodeStates(
    watcherId: string,
    nodeStates: readonly PipelineTerminalNodeState[]
  ): void {
    const parsedNodeStates = PipelineTerminalNodeStatesSchema.parse(nodeStates)
    runPipelineMutation(this.database, (db) => {
      db.prepare(`INSERT INTO pipeline_terminal_node_state (watcher_id, node_states_json)
        VALUES (?, ?)
        ON CONFLICT (watcher_id) DO UPDATE SET node_states_json = excluded.node_states_json`).run(
        watcherId,
        serializeJson(parsedNodeStates, 'terminal node states')
      )
    })
  }

  recordDispatch(args: RecordDispatchArgs): void {
    runPipelineMutation(this.database, (db) => {
      db.prepare(`INSERT INTO pipeline_dispatch (
        watcher_id, instance_id, epoch, attempt, dispatch_id, workspace_id, terminal_handle,
        report_path, dispatched_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (watcher_id, instance_id, epoch, attempt) DO UPDATE SET
        dispatch_id = excluded.dispatch_id,
        workspace_id = excluded.workspace_id,
        terminal_handle = excluded.terminal_handle,
        report_path = excluded.report_path,
        dispatched_at_ms = excluded.dispatched_at_ms`).run(
        args.watcherId,
        args.instanceId,
        args.epoch,
        args.attempt,
        args.dispatchId,
        args.workspaceId,
        args.terminalHandle,
        args.reportPath,
        args.dispatchedAtMs
      )
    })
  }

  recordAttemptBaseline(args: RecordAttemptBaselineArgs): void {
    runPipelineMutation(this.database, (db) => {
      db.prepare(`INSERT INTO pipeline_attempt_baseline (
        watcher_id, attempt_fingerprint, workspace_path, digest_json
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT (watcher_id, attempt_fingerprint) DO UPDATE SET
        workspace_path = excluded.workspace_path,
        digest_json = excluded.digest_json`).run(
        args.watcherId,
        args.attemptFingerprint,
        args.workspacePath,
        serializeJson(args.digest, 'attempt baseline digest')
      )
    })
  }

  attemptBaseline(
    watcherId: string,
    attemptFingerprint: string
  ): { workspacePath: string; digest: unknown } | null {
    const row = oneRow<AttemptBaselineRow>(
      this.database.connection().prepare(`SELECT workspace_path, digest_json
        FROM pipeline_attempt_baseline WHERE watcher_id = ? AND attempt_fingerprint = ?`),
      watcherId,
      attemptFingerprint
    )
    return row
      ? {
          workspacePath: row.workspace_path,
          digest: parseJson(row.digest_json, 'attempt baseline digest')
        }
      : null
  }

  recordSwarmExpansion(args: RecordSwarmExpansionArgs): void {
    runPipelineMutation(this.database, (db) => {
      db.prepare(`INSERT INTO pipeline_swarm_expansion (
        watcher_id, swarm_id, epoch, tasks_json, warnings_json, base_commit
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (watcher_id, swarm_id, epoch) DO UPDATE SET
        tasks_json = excluded.tasks_json,
        warnings_json = excluded.warnings_json,
        base_commit = excluded.base_commit`).run(
        args.watcherId,
        args.swarmId,
        args.epoch,
        serializeJson(args.tasks, 'Swarm tasks'),
        serializeJson(args.warnings, 'Swarm warnings'),
        args.baseCommit
      )
    })
  }

  recordChildWorktree(args: RecordChildWorktreeArgs): void {
    runPipelineMutation(this.database, (db) => {
      db.prepare(`INSERT INTO pipeline_child_worktree (
        watcher_id, instance_id, epoch, worktree_id, setup_state
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (watcher_id, instance_id, epoch) DO UPDATE SET
        worktree_id = excluded.worktree_id,
        setup_state = excluded.setup_state`).run(
        args.watcherId,
        args.instanceId,
        args.epoch,
        args.worktreeId,
        args.setupState
      )
    })
  }

  setMergeProgress(args: SetMergeProgressArgs): void {
    runPipelineMutation(this.database, (db) => {
      const existing = oneRow<{
        commit_sha: string | null
        applied_commit_sha: string | null
        conflict_json: string | null
      }>(
        db.prepare(`SELECT commit_sha, applied_commit_sha, conflict_json
          FROM pipeline_merge_progress
          WHERE watcher_id = ? AND merge_id = ? AND epoch = ? AND child_instance_id = ?`),
        args.watcherId,
        args.mergeId,
        args.epoch,
        args.childInstanceId
      )
      const commitSha =
        args.commitSha === undefined ? (existing?.commit_sha ?? null) : args.commitSha
      const appliedCommitSha =
        args.appliedCommitSha === undefined
          ? (existing?.applied_commit_sha ?? null)
          : args.appliedCommitSha
      const conflictJson =
        args.conflict === undefined
          ? (existing?.conflict_json ?? null)
          : args.conflict === null
            ? null
            : serializeJson(args.conflict, 'merge conflict')
      db.prepare(`INSERT INTO pipeline_merge_progress (
        watcher_id, merge_id, epoch, child_instance_id, state, commit_sha, applied_commit_sha,
        conflict_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (watcher_id, merge_id, epoch, child_instance_id) DO UPDATE SET
        state = excluded.state,
        commit_sha = excluded.commit_sha,
        applied_commit_sha = excluded.applied_commit_sha,
        conflict_json = excluded.conflict_json`).run(
        args.watcherId,
        args.mergeId,
        args.epoch,
        args.childInstanceId,
        args.state,
        commitSha,
        appliedCommitSha,
        conflictJson
      )
    })
  }

  recordComposite(args: RecordCompositeArgs): void {
    runPipelineMutation(this.database, (db) => {
      db.prepare(`INSERT INTO pipeline_composite (
        watcher_id, instance_id, epoch, kind, kind_payload_json, capabilities_json, activated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (watcher_id, instance_id, epoch) DO UPDATE SET
        kind = excluded.kind,
        kind_payload_json = excluded.kind_payload_json,
        capabilities_json = excluded.capabilities_json,
        activated_at_ms = excluded.activated_at_ms`).run(
        args.watcherId,
        args.instanceId,
        args.epoch,
        args.kind,
        serializeJson(args.kindPayload, 'composite kind payload'),
        serializeJson(args.capabilities, 'composite capabilities'),
        args.activatedAtMs
      )
    })
  }

  composite(
    watcherId: string,
    instanceId: string,
    epoch: number
  ): Omit<PipelineComposite, 'instanceId' | 'epoch'> | null {
    const row = oneRow<Omit<CompositeRow, 'instance_id' | 'epoch'>>(
      this.database.connection().prepare(`SELECT kind, kind_payload_json, capabilities_json,
        activated_at_ms FROM pipeline_composite
        WHERE watcher_id = ? AND instance_id = ? AND epoch = ?`),
      watcherId,
      instanceId,
      epoch
    )
    if (!row) {
      return null
    }
    if (row.kind !== 'hosted-review') {
      throw new Error('Pipeline database contains an invalid composite kind')
    }
    return {
      kind: row.kind,
      kindPayload: parseJson(row.kind_payload_json, 'composite kind payload'),
      capabilities: parseJson<PipelineComposite['capabilities']>(
        row.capabilities_json,
        'composite capabilities'
      ),
      activatedAtMs: row.activated_at_ms
    }
  }

  facts(watcherId: string): PipelineStoreFacts {
    const db = this.database.connection()
    const pin = this.runPin(watcherId)
    return readPipelineFacts(db, watcherId, pin)
  }

  purge(watcherId: string): void {
    runPipelineMutation(this.database, (db) => {
      for (const table of PIPELINE_TABLES) {
        db.prepare(`DELETE FROM ${table} WHERE watcher_id = ?`).run(watcherId)
      }
    })
  }

  reconcile(watcherId: string, recordedAttemptKeys: ReadonlySet<string>): void {
    runPipelineMutation(this.database, (db) => {
      const dispatches = allRows<DispatchAttemptKeyRow>(
        db.prepare(`SELECT instance_id, epoch, attempt
        FROM pipeline_dispatch WHERE watcher_id = ?`),
        watcherId
      )
      const removeDispatch = db.prepare(`DELETE FROM pipeline_dispatch
        WHERE watcher_id = ? AND instance_id = ? AND epoch = ? AND attempt = ?`)
      for (const row of dispatches) {
        if (!recordedAttemptKeys.has(`${row.instance_id}:${row.epoch}:${row.attempt}`)) {
          removeDispatch.run(watcherId, row.instance_id, row.epoch, row.attempt)
        }
      }

      const baselines = allRows<AttemptFingerprintRow>(
        db.prepare(`SELECT attempt_fingerprint
        FROM pipeline_attempt_baseline WHERE watcher_id = ?`),
        watcherId
      )
      const removeBaseline = db.prepare(`DELETE FROM pipeline_attempt_baseline
        WHERE watcher_id = ? AND attempt_fingerprint = ?`)
      for (const row of baselines) {
        if (!recordedAttemptKeys.has(row.attempt_fingerprint)) {
          removeBaseline.run(watcherId, row.attempt_fingerprint)
        }
      }
    })
  }
}
