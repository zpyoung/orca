import type { BudgetState } from '../../shared/fork-heimdall/budget'
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
import type {
  WatcherKindId,
  WatcherTerminalSummary
} from '../../shared/fork-heimdall/watcher-types'
import type Database from '../sqlite/sync-database'
import type { HeimdallDatabase } from './database'
import {
  assertAttemptResolution,
  assertAttemptTransition,
  assertIntervalTransition
} from './ledger-append-validation'
import {
  compactTerminalRetention,
  readTerminalRetentionSummary,
  reclaimLedgerObservations,
  reclaimTickTraces,
  reclaimWatcherRetention
} from './retention'
import { withImmediateTransaction, withReentrantImmediateTransaction } from './transaction-scope'

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
    totals: BudgetState
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
    return withReentrantImmediateTransaction(
      connection,
      () => {
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
        return seq
      },
      () => this.publish(parsed.watcherId)
    )
  }

  reclaim(watcherId: string): LedgerReclaimResult {
    this.requireWatcherId(watcherId)
    this.database.assertWritable()
    return reclaimWatcherRetention(this.database.connection(), watcherId)
  }

  releaseRetentionPin(eventId: string): void {
    if (!eventId) {
      throw new Error('An event id is required')
    }
    this.database.assertWritable()
    const connection = this.database.connection()
    withReentrantImmediateTransaction(connection, () => {
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
      const terminalSummary = readTerminalRetentionSummary(connection, row.watcher_id)
      if (terminalSummary) {
        this.compactTerminal(row.watcher_id, terminalSummary.kind, terminalSummary.totals)
      } else {
        reclaimLedgerObservations(connection, row.watcher_id)
      }
    })
  }

  appendTickTrace(watcherId: string, trace: WatcherTickTrace): void {
    this.requireWatcherId(watcherId)
    const parsed = WatcherTickTraceSchema.parse(trace)
    this.database.assertWritable()
    const connection = this.database.connection()
    withImmediateTransaction(connection, () => {
      this.assertWatcherOpenForTrace(connection, watcherId)
      connection
        .prepare(
          `INSERT INTO heimdall_tick_trace (watcher_id, seq, pinned, trace_json)
           VALUES (?, ?, ?, ?)`
        )
        .run(watcherId, parsed.seq, parsed.pinned ? 1 : 0, JSON.stringify(parsed))
      reclaimTickTraces(connection, watcherId)
    })
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
    withReentrantImmediateTransaction(connection, () => {
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
      const terminalSummary = readTerminalRetentionSummary(connection, watcherId)
      if (terminalSummary) {
        this.compactTerminal(watcherId, terminalSummary.kind, terminalSummary.totals)
      } else {
        reclaimTickTraces(connection, watcherId)
      }
    })
  }

  compactTerminal(
    watcherId: string,
    kind: WatcherKindId,
    totals: BudgetState
  ): WatcherTerminalSummary {
    this.requireWatcherId(watcherId)
    this.database.assertWritable()
    return compactTerminalRetention(
      this.database.connection(),
      watcherId,
      kind,
      totals,
      (connection, activeWatcherId) => this.readWithConnection(connection, activeWatcherId)
    )
  }

  readTerminalSummary(watcherId: string): WatcherTerminalSummary | null {
    this.requireWatcherId(watcherId)
    return readTerminalRetentionSummary(this.database.connection(), watcherId)
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
