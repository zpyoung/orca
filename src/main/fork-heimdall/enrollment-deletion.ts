import type { WatcherOwnerFence } from '../../shared/fork-heimdall/fleet-types'
import { WatcherKindIdSchema, type WatcherKindId } from '../../shared/fork-heimdall/watcher-types'
import type { HeimdallDatabase } from './database'
import type { EnrollmentRecord } from './enrollment-store'

export type EnrollmentDeleteCommit =
  | { status: 'deleted' }
  | {
      status: 'refused'
      reason: 'watcher-not-found' | 'owner-conflict' | 'stale-revision'
      detail: string
    }
export type PendingKindPurge = {
  watcherId: string
  kind: WatcherKindId
}

type EnrollmentDeletion = {
  database: HeimdallDatabase
  watcherId: string
  expectedOwner: WatcherOwnerFence
  read(): EnrollmentRecord | null
}

/** Applies the final owner fence and all kernel-store deletion in one writer transaction. */
export function deleteWatcherEnrollment(input: EnrollmentDeletion): EnrollmentDeleteCommit {
  if (!input.watcherId) {
    return { status: 'refused', reason: 'watcher-not-found', detail: 'A watcher id is required' }
  }
  input.database.assertWritable()
  const connection = input.database.connection()
  connection.exec('BEGIN IMMEDIATE')
  try {
    const current = input.read()
    if (!current) {
      connection.exec('ROLLBACK')
      return {
        status: 'refused',
        reason: 'watcher-not-found',
        detail: `Heimdall watcher ${input.watcherId} was not found`
      }
    }
    if (
      current.executionHostId !== input.expectedOwner.executionHostId ||
      current.schedulerOwner !== input.expectedOwner.schedulerOwner ||
      current.workspaceKey !== input.expectedOwner.workspaceKey
    ) {
      connection.exec('ROLLBACK')
      return {
        status: 'refused',
        reason: 'owner-conflict',
        detail: `Heimdall watcher ${input.watcherId} is owned by a different execution authority`
      }
    }
    if (current.commandRevision !== input.expectedOwner.revision) {
      connection.exec('ROLLBACK')
      return {
        status: 'refused',
        reason: 'stale-revision',
        detail: `Heimdall watcher ${input.watcherId} advanced to revision ${current.commandRevision}`
      }
    }

    connection
      .prepare(
        `INSERT INTO heimdall_pending_kind_purge (watcher_id, kind)
         VALUES (?, ?)`
      )
      .run(input.watcherId, current.kind)
    connection
      .prepare('DELETE FROM heimdall_terminal_summary WHERE watcher_id = ?')
      .run(input.watcherId)
    connection.prepare('DELETE FROM heimdall_tick_trace WHERE watcher_id = ?').run(input.watcherId)
    connection.prepare('DELETE FROM heimdall_ledger WHERE watcher_id = ?').run(input.watcherId)
    const deleted = connection
      .prepare('DELETE FROM heimdall_enrollment WHERE watcher_id = ? AND command_revision = ?')
      .run(input.watcherId, input.expectedOwner.revision)
    if (Number(deleted.changes) !== 1) {
      throw new Error(`Heimdall watcher ${input.watcherId} changed during its delete transaction`)
    }
    connection.exec('COMMIT')
    return { status: 'deleted' }
  } catch (error) {
    if (connection.isTransaction) {
      connection.exec('ROLLBACK')
    }
    throw error
  }
}

export function readPendingKindPurges(database: HeimdallDatabase): PendingKindPurge[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: node:sqlite types every row as unknown; this SELECT's literal column list is the row's only shape source.
  const rows = database
    .connection()
    .prepare(
      `SELECT watcher_id AS watcherId, kind
         FROM heimdall_pending_kind_purge
         ORDER BY watcher_id`
    )
    .all() as { watcherId: string; kind: string }[]
  return rows.map((row) => ({
    watcherId: row.watcherId,
    kind: WatcherKindIdSchema.parse(row.kind)
  }))
}

export function completePendingKindPurge(database: HeimdallDatabase, watcherId: string): void {
  database.assertWritable()
  database
    .connection()
    .prepare('DELETE FROM heimdall_pending_kind_purge WHERE watcher_id = ?')
    .run(watcherId)
}
