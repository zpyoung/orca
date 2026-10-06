import type { WatcherOwnerFence } from '../../shared/fork-heimdall/fleet-types'
import type { WatcherEnrollment, WorkspaceKey } from '../../shared/fork-heimdall/watcher-types'
import { getErrorCode } from '../git/worktree-operation-options'
import type { HeimdallDatabase } from '../fork-heimdall/database'
import type { EnrollmentDeleteCommit, PendingKindPurge } from '../fork-heimdall/enrollment-deletion'
import type { EnrollmentInsertRollbackResult } from '../fork-heimdall/enrollment-insert-rollback'
import {
  HeimdallEnrollmentStore,
  type EnrollmentControlChange,
  type EnrollmentControlCommit,
  type EnrollmentRecord,
  type EnrollmentRearmConfiguration,
  type EnrollmentStore
} from '../fork-heimdall/enrollment-store'
import { withReentrantImmediateTransaction } from '../fork-heimdall/transaction-scope'
import { BUILTIN_ENROLLMENT_TABLES, PIPELINE_ENROLLMENT_TABLES } from './pipeline-enrollment-table'

class DuplicateWorkspaceRefusal extends Error {
  readonly code = 'SQLITE_CONSTRAINT_UNIQUE'

  constructor(table: string) {
    super(`UNIQUE constraint failed: ${table}.workspace_key`)
  }
}

export function isDuplicateWorkspaceError(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error)
  return (
    getErrorCode(error) === 'SQLITE_CONSTRAINT_UNIQUE' &&
    (detail.includes('heimdall_enrollment.workspace_key') ||
      detail.includes('heimdall_pipeline_enrollment.workspace_key'))
  )
}

/** Routes pipeline enrollments to additive tables without changing the built-in tables. */
export class PipelineAwareEnrollmentStore implements EnrollmentStore {
  private readonly builtin: HeimdallEnrollmentStore
  private readonly pipeline: HeimdallEnrollmentStore

  constructor(private readonly database: HeimdallDatabase) {
    this.builtin = new HeimdallEnrollmentStore(database, BUILTIN_ENROLLMENT_TABLES)
    this.pipeline = new HeimdallEnrollmentStore(database, PIPELINE_ENROLLMENT_TABLES)
  }

  get(watcherId: string): EnrollmentRecord | null {
    return (
      (this.hasPipelineTables() ? this.pipeline.get(watcherId) : null) ??
      this.builtin.get(watcherId)
    )
  }

  list(): EnrollmentRecord[] {
    if (!this.hasPipelineTables()) {
      return this.builtin.list()
    }
    const builtinById = new Map(
      this.builtin.list().map((record) => [record.watcherId, record] as const)
    )
    const pipelineById = new Map(
      this.pipeline.list().map((record) => [record.watcherId, record] as const)
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these selected aliases come from the literal enrollment-table UNION.
    const order = this.database
      .connection()
      .prepare(
        `SELECT watcher_id AS watcherId, source
           FROM (
             SELECT watcher_id, created_at_ms, 0 AS source
               FROM ${BUILTIN_ENROLLMENT_TABLES.enrollment}
             UNION ALL
             SELECT watcher_id, created_at_ms, 1 AS source
               FROM ${PIPELINE_ENROLLMENT_TABLES.enrollment}
           )
          ORDER BY created_at_ms, watcher_id, source`
      )
      .all() as { watcherId: string; source: number }[]
    const records: EnrollmentRecord[] = []
    for (const row of order) {
      const record =
        row.source === 0 ? builtinById.get(row.watcherId) : pipelineById.get(row.watcherId)
      if (!record) {
        throw new Error(
          `Heimdall watcher ${row.watcherId} changed while the enrollment list was read`
        )
      }
      records.push(record)
    }
    return records
  }

  findLiveByWorkspace(workspaceKey: WorkspaceKey): EnrollmentRecord | null {
    return (
      this.builtin.findLiveByWorkspace(workspaceKey) ??
      (this.hasPipelineTables() ? this.pipeline.findLiveByWorkspace(workspaceKey) : null)
    )
  }

  insert(enrollment: WatcherEnrollment): WatcherEnrollment {
    const target = enrollment.kind === 'pipeline' ? this.pipeline : this.builtin
    const other = enrollment.kind === 'pipeline' ? this.builtin : this.pipeline
    const otherTable =
      enrollment.kind === 'pipeline'
        ? BUILTIN_ENROLLMENT_TABLES.enrollment
        : PIPELINE_ENROLLMENT_TABLES.enrollment
    this.database.assertWritable()
    return withReentrantImmediateTransaction(this.database.connection(), () => {
      if (other.findLiveByWorkspace(enrollment.workspaceKey)) {
        throw new DuplicateWorkspaceRefusal(otherTable)
      }
      return target.insert(enrollment)
    })
  }

  commitControl(
    watcherId: string,
    expectedOwner: WatcherOwnerFence,
    change: EnrollmentControlChange,
    appendWithinTransaction?: () => void
  ): EnrollmentControlCommit {
    return this.storeForWatcher(watcherId).commitControl(
      watcherId,
      expectedOwner,
      change,
      appendWithinTransaction
    )
  }

  rollbackInserted(enrollment: WatcherEnrollment): EnrollmentInsertRollbackResult {
    const target = enrollment.kind === 'pipeline' ? this.pipeline : this.builtin
    return target.rollbackInserted(enrollment)
  }

  deleteWatcher(watcherId: string, expectedOwner: WatcherOwnerFence): EnrollmentDeleteCommit {
    return this.storeForWatcher(watcherId).deleteWatcher(watcherId, expectedOwner)
  }

  pendingKindPurges(): PendingKindPurge[] {
    if (!this.hasPipelineTables()) {
      return this.builtin.pendingKindPurges()
    }
    return [...this.builtin.pendingKindPurges(), ...this.pipeline.pendingKindPurges()].sort(
      (left, right) =>
        left.watcherId < right.watcherId ? -1 : left.watcherId > right.watcherId ? 1 : 0
    )
  }

  completeKindPurge(watcherId: string): void {
    this.builtin.completeKindPurge(watcherId)
    this.pipeline.completeKindPurge(watcherId)
  }

  setEnabled(watcherId: string, enabled: boolean): EnrollmentRecord {
    return this.storeForWatcher(watcherId).setEnabled(watcherId, enabled)
  }

  rearm(
    watcherId: string,
    configuration: EnrollmentRearmConfiguration,
    appendWithinTransaction?: () => void
  ): WatcherEnrollment {
    return this.storeForWatcher(watcherId).rearm(watcherId, configuration, appendWithinTransaction)
  }

  setOrchestrationRunId(watcherId: string, runId: string | null): WatcherEnrollment {
    return this.storeForWatcher(watcherId).setOrchestrationRunId(watcherId, runId)
  }

  markTerminal(
    watcherId: string,
    terminalAtMs: number,
    appendWithinTransaction?: () => void,
    afterTerminalWithinTransaction?: () => void
  ): EnrollmentRecord {
    return this.storeForWatcher(watcherId).markTerminal(
      watcherId,
      terminalAtMs,
      appendWithinTransaction,
      afterTerminalWithinTransaction
    )
  }

  pipelineRowsClaimedByBuiltin(): {
    pipelineWatcherId: string
    builtinWatcherId: string
  }[] {
    if (!this.hasPipelineTables()) {
      return []
    }
    const statement = this.database.connection().prepare(
      `SELECT pipeline.watcher_id AS pipelineWatcherId,
                builtin.watcher_id AS builtinWatcherId
           FROM heimdall_pipeline_enrollment AS pipeline
           JOIN heimdall_enrollment AS builtin
             ON builtin.workspace_key = pipeline.workspace_key
          WHERE builtin.terminal_at_ms IS NULL
            AND pipeline.terminal_at_ms IS NULL
          ORDER BY pipeline.watcher_id, builtin.watcher_id`
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this selected alias list is the statement's only row shape source.
    const rows = statement.all() as {
      pipelineWatcherId: string
      builtinWatcherId: string
    }[]
    return rows
  }

  private storeForWatcher(watcherId: string): HeimdallEnrollmentStore {
    return this.hasPipelineTables() && this.pipeline.get(watcherId) ? this.pipeline : this.builtin
  }

  // a read-only database from a newer build may never have had the side tables created
  private hasPipelineTables(): boolean {
    if (!this.database.isReadOnly()) {
      return true
    }
    const row = this.database
      .connection()
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(PIPELINE_ENROLLMENT_TABLES.enrollment)
    return row !== undefined
  }
}
