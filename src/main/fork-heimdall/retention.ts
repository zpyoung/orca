import { TICK_TRACE_RING_CAPACITY } from '../../shared/fork-heimdall/tick-trace'
import type Database from '../sqlite/sync-database'

export const RETENTION_RING_CAPACITY = TICK_TRACE_RING_CAPACITY

function excessRows(
  database: Database.Database,
  table: 'heimdall_ledger' | 'heimdall_tick_trace',
  watcherId: string,
  predicate = ''
): number {
  const row = database
    .prepare(
      `SELECT COUNT(*) AS count
         FROM ${table}
        WHERE watcher_id = ?${predicate}`
    )
    .get(watcherId) as { count: number }
  return Math.max(0, Number(row.count) - RETENTION_RING_CAPACITY)
}

/** Keeps the observation ring bounded while never deleting a row whose resolution is outstanding. */
export function reclaimLedgerObservations(database: Database.Database, watcherId: string): number {
  const excess = excessRows(database, 'heimdall_ledger', watcherId, " AND class = 'observation'")
  if (excess === 0) {
    return 0
  }

  const result = database
    .prepare(
      `DELETE FROM heimdall_ledger
        WHERE watcher_id = ?
          AND class = 'observation'
          AND resolved = 1
          AND seq IN (
            SELECT seq
              FROM heimdall_ledger
             WHERE watcher_id = ? AND class = 'observation' AND resolved = 1
             ORDER BY seq
             LIMIT ?
          )`
    )
    .run(watcherId, watcherId, excess)
  return Number(result.changes)
}

/** Applies the same pin-aware ring policy to persisted tick traces. */
export function reclaimTickTraces(database: Database.Database, watcherId: string): number {
  const excess = excessRows(database, 'heimdall_tick_trace', watcherId)
  if (excess === 0) {
    return 0
  }

  const result = database
    .prepare(
      `DELETE FROM heimdall_tick_trace
        WHERE watcher_id = ?
          AND pinned = 0
          AND seq IN (
            SELECT seq
              FROM heimdall_tick_trace
             WHERE watcher_id = ? AND pinned = 0
             ORDER BY seq
             LIMIT ?
          )`
    )
    .run(watcherId, watcherId, excess)
  return Number(result.changes)
}
