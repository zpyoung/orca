import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import type { EnrollmentTableSet } from '../fork-heimdall-pipeline/pipeline-enrollment-table'
import type { HeimdallDatabase } from './database'
import { withImmediateTransaction } from './transaction-scope'

export type EnrollmentInsertRollbackResult =
  | { status: 'rolled-back' }
  | { status: 'not-found' }
  | { status: 'refused'; reason: 'row-changed'; detail: string }

type EnrollmentInsertRollback = {
  database: HeimdallDatabase
  enrollment: WatcherEnrollment
  tables: EnrollmentTableSet
}

/** Deletes only an unchanged, newly inserted enrollment; it leaves all other Heimdall data alone. */
export function rollbackInsertedEnrollment(
  input: EnrollmentInsertRollback
): EnrollmentInsertRollbackResult {
  const { database, enrollment, tables } = input
  database.assertWritable()
  const connection = database.connection()
  return withImmediateTransaction(connection, () => {
    const deleted = connection
      .prepare(
        `DELETE FROM ${tables.enrollment}
          WHERE watcher_id = ?
            AND kind = ?
            AND execution_host_id = ?
            AND scheduler_owner = ?
            AND workspace_key = ?
            AND command_revision = ?
            AND created_at_ms = ?
            AND enabled = 1
            AND paused = 0
            AND orchestration_run_id IS NULL
            AND terminal_at_ms IS NULL`
      )
      .run(
        enrollment.watcherId,
        enrollment.kind,
        enrollment.executionHostId,
        enrollment.schedulerOwner,
        enrollment.workspaceKey,
        enrollment.commandRevision,
        enrollment.createdAtMs
      )
    if (Number(deleted.changes) === 1) {
      return { status: 'rolled-back' }
    }
    const existing = connection
      .prepare(`SELECT 1 FROM ${tables.enrollment} WHERE watcher_id = ?`)
      .get(enrollment.watcherId)
    if (existing === undefined) {
      return { status: 'not-found' }
    }
    return {
      status: 'refused',
      reason: 'row-changed',
      detail: `Heimdall watcher ${enrollment.watcherId} changed after insertion`
    }
  })
}
