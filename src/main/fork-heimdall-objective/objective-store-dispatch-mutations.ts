import {
  ObjectiveDispatchRecordSchema,
  type ObjectiveDispatchRecord
} from '../../shared/fork-heimdall-objective/parallel-types'
import type { ObjectiveDatabase } from './objective-database'
import { runObjectiveMutation } from './objective-database-transaction'

/** Durable mutations for parallel dispatch state, kept separate from plan and review mutations. */
export class ObjectiveStoreDispatchMutations {
  constructor(private readonly database: ObjectiveDatabase) {}

  save(input: ObjectiveDispatchRecord): ObjectiveDispatchRecord {
    const record = ObjectiveDispatchRecordSchema.parse(input)
    return runObjectiveMutation(this.database, () => {
      const db = this.database.connection()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: node:sqlite returns an untyped row; objective_dispatch's selected columns are written only by this store to match ObjectiveDispatchRecord's field types.
      const existing = db
        .prepare(`SELECT watcher_id, execution_host_id, revision_id, task_key, plan_task_digest,
          created_at_ms FROM objective_dispatch WHERE attempt_fingerprint = ?`)
        .get(record.attemptFingerprint) as
        | {
            watcher_id: string
            execution_host_id: string
            revision_id: string
            task_key: string
            plan_task_digest: string
            created_at_ms: number
          }
        | undefined
      if (
        existing &&
        (existing.watcher_id !== record.watcherId ||
          existing.execution_host_id !== record.executionHostId ||
          existing.revision_id !== record.revisionId ||
          existing.task_key !== record.taskKey ||
          existing.plan_task_digest !== record.planTaskDigest ||
          existing.created_at_ms !== record.createdAtMs)
      ) {
        throw new Error('Objective dispatch identity was replayed with different content')
      }
      db.prepare(`INSERT INTO objective_dispatch (
        attempt_fingerprint, watcher_id, execution_host_id, revision_id, task_key, plan_task_digest,
        dispatch_id, workspace_id, workspace_path, base_commit, lane_task_keys_json, session_node_count, state,
        commit_sha, applied_commit_sha, report_digest, conflict_paths_json,
        conflicting_task_keys_json, conflicting_dispatch_ids_json, created_at_ms, completed_at_ms,
        terminal_handle, setup_state, report_path, report_json, task_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (attempt_fingerprint) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        workspace_path = excluded.workspace_path,
        dispatch_id = excluded.dispatch_id,
        plan_task_digest = excluded.plan_task_digest,
        base_commit = excluded.base_commit,
        lane_task_keys_json = excluded.lane_task_keys_json,
        session_node_count = excluded.session_node_count,
        state = excluded.state,
        commit_sha = excluded.commit_sha,
        applied_commit_sha = excluded.applied_commit_sha,
        report_digest = excluded.report_digest,
        conflict_paths_json = excluded.conflict_paths_json,
        conflicting_task_keys_json = excluded.conflicting_task_keys_json,
        conflicting_dispatch_ids_json = excluded.conflicting_dispatch_ids_json,
        completed_at_ms = excluded.completed_at_ms,
        terminal_handle = excluded.terminal_handle,
        setup_state = excluded.setup_state,
        report_path = excluded.report_path,
        report_json = excluded.report_json,
        task_json = excluded.task_json`).run(
        record.attemptFingerprint,
        record.watcherId,
        record.executionHostId,
        record.revisionId,
        record.taskKey,
        record.planTaskDigest,
        record.dispatchId,
        record.workspaceId,
        record.workspacePath,
        record.baseCommit,
        JSON.stringify(record.laneTaskKeys),
        record.sessionNodeCount,
        record.state,
        record.commitSha,
        record.appliedCommitSha,
        record.reportDigest,
        JSON.stringify(record.conflictPaths),
        JSON.stringify(record.conflictingTaskKeys),
        JSON.stringify(record.conflictingDispatchIds),
        record.createdAtMs,
        record.completedAtMs,
        record.terminalHandle,
        record.setupState,
        record.reportPath,
        record.report === null ? null : JSON.stringify(record.report),
        JSON.stringify(record.task)
      )
      return record
    })
  }

  setNote(watcherId: string, note: string | null, updatedAtMs: number): void {
    runObjectiveMutation(this.database, () => {
      const db = this.database.connection()
      if (note === null) {
        db.prepare('DELETE FROM objective_parallel_state WHERE watcher_id = ?').run(watcherId)
        return
      }
      const value = note.trim()
      if (!value || value.length > 2_048) {
        throw new Error('Objective parallel note must be between 1 and 2048 characters')
      }
      db.prepare(`INSERT INTO objective_parallel_state (watcher_id, note, updated_at_ms)
        VALUES (?, ?, ?)
        ON CONFLICT (watcher_id) DO UPDATE SET
          note = excluded.note, updated_at_ms = excluded.updated_at_ms`).run(
        watcherId,
        value,
        updatedAtMs
      )
    })
  }

  clearNoteWithPrefix(watcherId: string, prefix: string): void {
    runObjectiveMutation(this.database, () => {
      this.database
        .connection()
        .prepare(
          `DELETE FROM objective_parallel_state
          WHERE watcher_id = ? AND substr(note, 1, length(?)) = ?`
        )
        .run(watcherId, prefix, prefix)
    })
  }
}
