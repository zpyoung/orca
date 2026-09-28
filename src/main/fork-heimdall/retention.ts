import type { BudgetState } from '../../shared/fork-heimdall/budget'
import { getUnresolvedAttempts } from '../../shared/fork-heimdall/ledger-queries'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import { TICK_TRACE_RING_CAPACITY } from '../../shared/fork-heimdall/tick-trace'
import {
  WatcherTerminalSummarySchema,
  type WatcherKindId,
  type WatcherTerminalSummary
} from '../../shared/fork-heimdall/watcher-types'
import type Database from '../sqlite/sync-database'
import { withReentrantImmediateTransaction } from './transaction-scope'

export const RETENTION_RING_CAPACITY = TICK_TRACE_RING_CAPACITY

function excessRows(
  database: Database.Database,
  table: 'heimdall_ledger' | 'heimdall_tick_trace',
  watcherId: string,
  predicate = ''
): number {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: node:sqlite types every row as unknown; this SELECT's literal column list is the row's only shape source.
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

type TerminalSummaryRow = {
  watcher_id: string
  kind: string
  terminal_state: string
  reason: string
  totals_json: string
  at_ms: number
}

type TerminalCompactionLedgerReader = (
  database: Database.Database,
  watcherId: string
) => WatcherLedger

export function reclaimWatcherRetention(
  database: Database.Database,
  watcherId: string
): { observations: number; tickTraces: number } {
  return withReentrantImmediateTransaction(database, () => ({
    observations: reclaimLedgerObservations(database, watcherId),
    tickTraces: reclaimTickTraces(database, watcherId)
  }))
}

export function readTerminalRetentionSummary(
  database: Database.Database,
  watcherId: string
): WatcherTerminalSummary | null {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: node:sqlite types every row as unknown; this SELECT's literal column list is the row's only shape source.
  const row = database
    .prepare(
      `SELECT watcher_id, kind, terminal_state, reason, totals_json, at_ms
         FROM heimdall_terminal_summary
        WHERE watcher_id = ?`
    )
    .get(watcherId) as TerminalSummaryRow | undefined
  if (!row) {
    return null
  }
  return WatcherTerminalSummarySchema.parse({
    watcherId: row.watcher_id,
    kind: row.kind,
    terminalState: row.terminal_state,
    reason: row.reason,
    totals: JSON.parse(row.totals_json),
    atMs: row.at_ms
  })
}

export function compactTerminalRetention(
  database: Database.Database,
  watcherId: string,
  kind: WatcherKindId,
  totals: BudgetState,
  readLedger: TerminalCompactionLedgerReader
): WatcherTerminalSummary {
  return withReentrantImmediateTransaction(database, () => {
    const existing = readTerminalRetentionSummary(database, watcherId)
    const ledger = readLedger(database, watcherId)
    let summary = existing
    if (!summary) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: node:sqlite types every row as unknown; this SELECT's literal column list is the row's only shape source.
      const enrollment = database
        .prepare(
          `SELECT kind, terminal_at_ms
             FROM heimdall_enrollment
            WHERE watcher_id = ?`
        )
        .get(watcherId) as { kind: string; terminal_at_ms: number | null } | undefined
      if (!enrollment || enrollment.terminal_at_ms === null) {
        throw new Error(`Heimdall watcher ${watcherId} has not been dismissed`)
      }
      if (enrollment.kind !== kind) {
        throw new Error(`Heimdall watcher ${watcherId} kind does not match its enrollment`)
      }

      const terminal = ledger.entries.find((entry) => entry.kind === 'terminal')
      if (!terminal || terminal.kind !== 'terminal') {
        throw new Error(`Heimdall watcher ${watcherId} has no terminal ledger entry`)
      }
      summary = WatcherTerminalSummarySchema.parse({
        watcherId,
        kind,
        terminalState: terminal.state,
        reason: terminal.reason,
        totals,
        atMs: terminal.atMs
      })
      database
        .prepare(
          `INSERT INTO heimdall_terminal_summary (
             watcher_id, kind, terminal_state, reason, totals_json, at_ms
           ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          summary.watcherId,
          summary.kind,
          summary.terminalState,
          summary.reason,
          JSON.stringify(summary.totals),
          summary.atMs
        )
    }

    const pinnedEventIds = new Set(getUnresolvedAttempts(ledger).map((entry) => entry.eventId))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: node:sqlite types every row as unknown; this SELECT's literal column list is the row's only shape source.
    const rows = database
      .prepare(
        `SELECT event_id, class, kind, resolved
           FROM heimdall_ledger
          WHERE watcher_id = ?`
      )
      .all(watcherId) as {
      event_id: string
      class: string
      kind: string
      resolved: number
    }[]
    const deleteRow = database.prepare(
      'DELETE FROM heimdall_ledger WHERE watcher_id = ? AND event_id = ?'
    )
    for (const row of rows) {
      const isPinnedObservation = row.class === 'observation' && row.resolved === 0
      if (row.kind !== 'terminal' && !isPinnedObservation && !pinnedEventIds.has(row.event_id)) {
        deleteRow.run(watcherId, row.event_id)
      }
    }
    database
      .prepare('DELETE FROM heimdall_tick_trace WHERE watcher_id = ? AND pinned = 0')
      .run(watcherId)
    return summary
  })
}
