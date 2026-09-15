import { getUnresolvedAttempts } from '../../shared/fork-heimdall/ledger-queries'
import {
  LedgerEntrySchema,
  WatcherLedgerSchema,
  type LedgerEntry,
  type WatcherLedger
} from '../../shared/fork-heimdall/ledger-types'
import {
  WatcherTickTraceSchema,
  type WatcherTickTrace
} from '../../shared/fork-heimdall/tick-trace'
import {
  WatcherTerminalSummarySchema,
  type WatcherKindId,
  type WatcherTerminalSummary
} from '../../shared/fork-heimdall/watcher-types'
import type Database from '../sqlite/sync-database'
import type { HeimdallDatabase } from './database'
import {
  assertAttemptResolution,
  assertAttemptTransition,
  assertIntervalTransition
} from './ledger-append-validation'
import { reclaimLedgerObservations, reclaimTickTraces } from './retention'

type LedgerRow = {
  watcher_id: string
  seq: number
  event_id: string
  at_ms: number
  class: string
  kind: string
  origin: string
  resolved: number
  entry_json: string
}

type TickTraceRow = {
  watcher_id: string
  seq: number
  pinned: number
  trace_json: string
}

type TerminalSummaryRow = {
  watcher_id: string
  kind: string
  terminal_state: string
  reason: string
  totals_json: string
  at_ms: number
}

export type LedgerAppendOptions = {
  /** False pins an observation until releaseRetentionPin records that reclaim is safe. */
  resolved?: boolean
}

export type LedgerReclaimResult = {
  observations: number
  tickTraces: number
}

export type LedgerStore = {
  read(watcherId: string): WatcherLedger
  append(entry: LedgerEntry, options?: LedgerAppendOptions): number
  reclaim(watcherId: string): LedgerReclaimResult
  appendTickTrace(watcherId: string, trace: WatcherTickTrace): void
  readTickTraces(watcherId: string): WatcherTickTrace[]
  releaseRetentionPin(eventId: string): void
  releaseTickTracePin(watcherId: string, seq: number): void
  compactTerminal(
    watcherId: string,
    kind: WatcherKindId,
    totals: Record<string, unknown>
  ): WatcherTerminalSummary
  readTerminalSummary(watcherId: string): WatcherTerminalSummary | null
}

/** Synchronous append-only ledger and its explicitly bounded retention projections. */
export class HeimdallLedgerStore implements LedgerStore {
  private readonly listeners = new Set<(watcherId: string) => void>()

  constructor(private readonly database: HeimdallDatabase) {}

  subscribe(listener: (watcherId: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  read(watcherId: string): WatcherLedger {
    this.requireWatcherId(watcherId)
    const rows = this.database
      .connection()
      .prepare(
        `SELECT watcher_id, seq, event_id, at_ms, class, kind, origin, resolved, entry_json
           FROM heimdall_ledger
          WHERE watcher_id = ?
          ORDER BY seq`
      )
      .all(watcherId) as LedgerRow[]
    return WatcherLedgerSchema.parse({
      watcherId,
      entries: rows.map((row) => this.parseLedgerRow(row, watcherId))
    })
  }

  append(entry: LedgerEntry, options: LedgerAppendOptions = {}): number {
    const parsed = LedgerEntrySchema.parse(entry)
    if (parsed.origin === 'client' && parsed.kind !== 'client-observation') {
      throw new Error("Ledger origin 'client' is restricted to client-observation")
    }
    if (parsed.class !== 'observation' && options.resolved !== undefined) {
      throw new Error('Retention resolution applies only to observation-class entries')
    }

    this.database.assertWritable()
    const connection = this.database.connection()
    const ownsTransaction = !connection.isTransaction
    if (ownsTransaction) {
      connection.exec('BEGIN IMMEDIATE')
    }
    try {
      this.assertLedgerOpen(connection, parsed)
      if (parsed.kind === 'attempt-resolved') {
        assertAttemptResolution(this.readWithConnection(connection, parsed.watcherId), parsed)
      } else if (parsed.kind === 'attempt') {
        assertAttemptTransition(this.readWithConnection(connection, parsed.watcherId), parsed)
      } else if (
        parsed.kind === 'interval-open' ||
        parsed.kind === 'interval-checkpoint' ||
        parsed.kind === 'interval-close'
      ) {
        assertIntervalTransition(this.readWithConnection(connection, parsed.watcherId), parsed)
      }

      const seq = this.nextSequence(connection, 'heimdall_ledger', parsed.watcherId)
      const resolved =
        parsed.class === 'observation'
          ? (options.resolved ?? true)
          : !(
              parsed.kind === 'attempt' &&
              parsed.state === 'settled' &&
              parsed.effect === 'indeterminate'
            )
      connection
        .prepare(
          `INSERT INTO heimdall_ledger (
             watcher_id, seq, event_id, at_ms, class, kind, origin, resolved, entry_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          parsed.watcherId,
          seq,
          parsed.eventId,
          parsed.atMs,
          parsed.class,
          parsed.kind,
          parsed.origin,
          resolved ? 1 : 0,
          JSON.stringify(parsed)
        )
      if (parsed.class === 'observation') {
        reclaimLedgerObservations(connection, parsed.watcherId)
      }
      if (ownsTransaction) {
        connection.exec('COMMIT')
        this.publish(parsed.watcherId)
      }
      return seq
    } catch (error) {
      if (ownsTransaction && connection.isTransaction) {
        connection.exec('ROLLBACK')
      }
      throw error
    }
  }

  reclaim(watcherId: string): LedgerReclaimResult {
    this.requireWatcherId(watcherId)
    this.database.assertWritable()
    const connection = this.database.connection()
    connection.exec('BEGIN IMMEDIATE')
    try {
      const result = {
        observations: reclaimLedgerObservations(connection, watcherId),
        tickTraces: reclaimTickTraces(connection, watcherId)
      }
      connection.exec('COMMIT')
      return result
    } catch (error) {
      connection.exec('ROLLBACK')
      throw error
    }
  }

  releaseRetentionPin(eventId: string): void {
    if (!eventId) {
      throw new Error('An event id is required')
    }
    this.database.assertWritable()
    const connection = this.database.connection()
    const row = connection
      .prepare('SELECT watcher_id FROM heimdall_ledger WHERE event_id = ?')
      .get(eventId) as { watcher_id: string } | undefined
    if (!row) {
      throw new Error(`Unknown Heimdall ledger event: ${eventId}`)
    }
    const result = connection
      .prepare(
        `UPDATE heimdall_ledger
            SET resolved = 1
          WHERE event_id = ? AND class = 'observation'`
      )
      .run(eventId)
    if (Number(result.changes) !== 1) {
      throw new Error(`Heimdall fact entries cannot carry retention pins: ${eventId}`)
    }
    reclaimLedgerObservations(connection, row.watcher_id)
  }

  appendTickTrace(watcherId: string, trace: WatcherTickTrace): void {
    this.requireWatcherId(watcherId)
    const parsed = WatcherTickTraceSchema.parse(trace)
    this.database.assertWritable()
    const connection = this.database.connection()
    connection.exec('BEGIN IMMEDIATE')
    try {
      this.assertWatcherOpenForTrace(connection, watcherId)
      connection
        .prepare(
          `INSERT INTO heimdall_tick_trace (watcher_id, seq, pinned, trace_json)
           VALUES (?, ?, ?, ?)`
        )
        .run(watcherId, parsed.seq, parsed.pinned ? 1 : 0, JSON.stringify(parsed))
      reclaimTickTraces(connection, watcherId)
      connection.exec('COMMIT')
    } catch (error) {
      connection.exec('ROLLBACK')
      throw error
    }
    this.publish(watcherId)
  }

  readTickTraces(watcherId: string): WatcherTickTrace[] {
    this.requireWatcherId(watcherId)
    const rows = this.database
      .connection()
      .prepare(
        `SELECT watcher_id, seq, pinned, trace_json
           FROM heimdall_tick_trace
          WHERE watcher_id = ?
          ORDER BY seq`
      )
      .all(watcherId) as TickTraceRow[]
    return rows.map((row) => {
      const trace = WatcherTickTraceSchema.parse(JSON.parse(row.trace_json))
      if (
        row.watcher_id !== watcherId ||
        trace.seq !== row.seq ||
        trace.pinned !== (row.pinned === 1)
      ) {
        throw new Error(`Heimdall tick trace ${row.seq} failed its durable envelope check`)
      }
      return trace
    })
  }

  releaseTickTracePin(watcherId: string, seq: number): void {
    this.requireWatcherId(watcherId)
    if (!Number.isSafeInteger(seq) || seq <= 0) {
      throw new Error('A positive trace sequence is required')
    }
    this.database.assertWritable()
    const connection = this.database.connection()
    const result = connection
      .prepare(
        `UPDATE heimdall_tick_trace
            SET pinned = 0,
                trace_json = json_set(trace_json, '$.pinned', json('false'))
          WHERE watcher_id = ? AND seq = ? AND pinned = 1`
      )
      .run(watcherId, seq)
    if (Number(result.changes) !== 1) {
      throw new Error(`Unknown or unpinned Heimdall tick trace: ${watcherId}/${seq}`)
    }
    reclaimTickTraces(connection, watcherId)
  }

  compactTerminal(
    watcherId: string,
    kind: WatcherKindId,
    totals: Record<string, unknown>
  ): WatcherTerminalSummary {
    this.requireWatcherId(watcherId)
    this.database.assertWritable()
    const connection = this.database.connection()
    connection.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.readTerminalSummaryWithConnection(connection, watcherId)
      if (existing) {
        connection.exec('COMMIT')
        return existing
      }

      const enrollment = connection
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

      const ledger = this.readWithConnection(connection, watcherId)
      const terminal = ledger.entries.find((entry) => entry.kind === 'terminal')
      if (!terminal || terminal.kind !== 'terminal') {
        throw new Error(`Heimdall watcher ${watcherId} has no terminal ledger entry`)
      }
      const summary = WatcherTerminalSummarySchema.parse({
        watcherId,
        kind,
        terminalState: terminal.state,
        reason: terminal.reason,
        totals,
        atMs: terminal.atMs
      })
      connection
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

      const pinnedEventIds = new Set(getUnresolvedAttempts(ledger).map((entry) => entry.eventId))
      const rows = connection
        .prepare(
          `SELECT event_id, class, resolved
             FROM heimdall_ledger
            WHERE watcher_id = ?`
        )
        .all(watcherId) as { event_id: string; class: string; resolved: number }[]
      const deleteRow = connection.prepare(
        'DELETE FROM heimdall_ledger WHERE watcher_id = ? AND event_id = ?'
      )
      for (const row of rows) {
        const isPinnedObservation = row.class === 'observation' && row.resolved === 0
        if (!isPinnedObservation && !pinnedEventIds.has(row.event_id)) {
          deleteRow.run(watcherId, row.event_id)
        }
      }
      connection
        .prepare('DELETE FROM heimdall_tick_trace WHERE watcher_id = ? AND pinned = 0')
        .run(watcherId)
      connection.exec('COMMIT')
      return summary
    } catch (error) {
      connection.exec('ROLLBACK')
      throw error
    }
  }

  readTerminalSummary(watcherId: string): WatcherTerminalSummary | null {
    this.requireWatcherId(watcherId)
    return this.readTerminalSummaryWithConnection(this.database.connection(), watcherId)
  }

  private readTerminalSummaryWithConnection(
    connection: Database.Database,
    watcherId: string
  ): WatcherTerminalSummary | null {
    const row = connection
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

  private assertLedgerOpen(connection: Database.Database, entry: LedgerEntry): void {
    const terminal = connection
      .prepare(
        `SELECT kind
           FROM heimdall_ledger
          WHERE watcher_id = ? AND kind = 'terminal'
          UNION ALL
         SELECT 'terminal-summary' AS kind
           FROM heimdall_terminal_summary
          WHERE watcher_id = ?
          LIMIT 1`
      )
      .get(entry.watcherId, entry.watcherId) as { kind: string } | undefined
    if (!terminal) {
      return
    }
    if (entry.kind === 'terminal') {
      throw new Error(`Heimdall watcher ${entry.watcherId} is already terminal`)
    }
    throw new Error(`Heimdall watcher ${entry.watcherId} ledger is terminal`)
  }

  private assertWatcherOpenForTrace(connection: Database.Database, watcherId: string): void {
    const terminal = connection
      .prepare(
        `SELECT 1 AS present
           FROM heimdall_ledger
          WHERE watcher_id = ? AND kind = 'terminal'
          UNION ALL
         SELECT 1 AS present
           FROM heimdall_terminal_summary
          WHERE watcher_id = ?
          LIMIT 1`
      )
      .get(watcherId, watcherId)
    if (terminal) {
      throw new Error(`Heimdall watcher ${watcherId} ledger is terminal`)
    }
  }

  private readWithConnection(connection: Database.Database, watcherId: string): WatcherLedger {
    const rows = connection
      .prepare(
        `SELECT watcher_id, seq, event_id, at_ms, class, kind, origin, resolved, entry_json
           FROM heimdall_ledger
          WHERE watcher_id = ?
          ORDER BY seq`
      )
      .all(watcherId) as LedgerRow[]
    return WatcherLedgerSchema.parse({
      watcherId,
      entries: rows.map((row) => this.parseLedgerRow(row, watcherId))
    })
  }

  private parseLedgerRow(row: LedgerRow, expectedWatcherId: string): LedgerEntry {
    try {
      const parsed = LedgerEntrySchema.parse(JSON.parse(row.entry_json))
      if (
        parsed.watcherId !== expectedWatcherId ||
        row.watcher_id !== expectedWatcherId ||
        parsed.eventId !== row.event_id ||
        parsed.atMs !== row.at_ms ||
        parsed.class !== row.class ||
        parsed.kind !== row.kind ||
        parsed.origin !== row.origin
      ) {
        throw new Error('durable envelope does not match its payload')
      }
      return parsed
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return LedgerEntrySchema.parse({
        kind: 'escalation',
        eventId: `malformed:${row.event_id}:${row.seq}`,
        watcherId: expectedWatcherId,
        atMs: Number.isSafeInteger(row.at_ms) && row.at_ms >= 0 ? row.at_ms : 0,
        origin: 'owner',
        class: 'fact',
        escalationId: `malformed-ledger-row:${row.seq}`,
        escalationKind: 'malformed-ledger-entry',
        status: 'escalated',
        foldCount: 1,
        reason
      })
    }
  }

  private nextSequence(
    connection: Database.Database,
    table: 'heimdall_ledger' | 'heimdall_tick_trace',
    watcherId: string
  ): number {
    const row = connection
      .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM ${table} WHERE watcher_id = ?`)
      .get(watcherId) as { seq: number }
    return Number(row.seq)
  }

  private requireWatcherId(watcherId: string): void {
    if (!watcherId) {
      throw new Error('A watcher id is required')
    }
  }
  private publish(watcherId: string): void {
    for (const listener of this.listeners) {
      listener(watcherId)
    }
  }
}
