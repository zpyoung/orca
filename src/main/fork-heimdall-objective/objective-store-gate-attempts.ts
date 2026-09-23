import type Database from '../sqlite/sync-database'
import type { ObjectiveDatabase } from './objective-database'
import { runObjectiveMutation } from './objective-database-transaction'
import { naturalId } from './objective-store-data'

export type StartGateAttemptArgs = {
  watcherId: string
  gateName: string
  contentIdentity: string
  executionHostId: string
  command: string
  epoch: number
  startedAtMs: number
}

export type CompleteGateAttemptArgs = {
  watcherId: string
  gateName: string
  contentIdentity: string
  exitCode: number | null
  timedOut: boolean
  stdoutTail: string
  stderrTail: string
  completedAtMs: number
}

export type ObjectiveGateAttempt = {
  id: string
  watcherId: string
  gateName: string
  contentIdentity: string
  executionHostId: string
  command: string
  epoch: number
  startedAtMs: number
  exitCode: number | null
  timedOut: boolean | null
  stdoutTail: string | null
  stderrTail: string | null
  completedAtMs: number | null
}

type GateAttemptRow = {
  id: string
  watcher_id: string
  gate_name: string
  content_identity: string
  execution_host_id: string
  command: string
  epoch: number
  started_at_ms: number
  exit_code: number | null
  timed_out: number | null
  stdout_tail: string | null
  stderr_tail: string | null
  completed_at_ms: number | null
}

const GATE_ATTEMPT_COLUMNS = `id, watcher_id, gate_name, content_identity, execution_host_id,
  command, epoch, started_at_ms, exit_code, timed_out, stdout_tail, stderr_tail, completed_at_ms`

function gateAttemptRecord(row: GateAttemptRow): ObjectiveGateAttempt {
  return {
    id: row.id,
    watcherId: row.watcher_id,
    gateName: row.gate_name,
    contentIdentity: row.content_identity,
    executionHostId: row.execution_host_id,
    command: row.command,
    epoch: row.epoch,
    startedAtMs: row.started_at_ms,
    exitCode: row.exit_code,
    timedOut: row.timed_out === null ? null : row.timed_out === 1,
    stdoutTail: row.stdout_tail,
    stderrTail: row.stderr_tail,
    completedAtMs: row.completed_at_ms
  }
}

function readGateAttemptRow(
  db: Database.Database,
  watcherId: string,
  gateName: string,
  contentIdentity: string
): GateAttemptRow | undefined {
  return db
    .prepare(
      `SELECT ${GATE_ATTEMPT_COLUMNS} FROM gate_attempt
       WHERE watcher_id = ? AND gate_name = ? AND content_identity = ?`
    )
    .get(watcherId, gateName, contentIdentity) as GateAttemptRow | undefined
}

/** Starts a durable pre-landing gate run, natural-keyed like `startCheckAttempt` on the content it ran against. */
export function startGateAttempt(
  database: ObjectiveDatabase,
  args: StartGateAttemptArgs
): ObjectiveGateAttempt {
  return runObjectiveMutation(database, (db) => {
    db.prepare(
      `INSERT INTO gate_attempt (
        id, watcher_id, gate_name, content_identity, execution_host_id, command,
        exit_code, timed_out, stdout_tail, stderr_tail, epoch, started_at_ms, completed_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL)
      ON CONFLICT (watcher_id, gate_name, content_identity) DO NOTHING`
    ).run(
      naturalId('objective_gate_attempt', args.watcherId, args.gateName, args.contentIdentity),
      args.watcherId,
      args.gateName,
      args.contentIdentity,
      args.executionHostId,
      args.command,
      args.epoch,
      args.startedAtMs
    )
    const stored = readGateAttemptRow(db, args.watcherId, args.gateName, args.contentIdentity)
    if (
      !stored ||
      stored.execution_host_id !== args.executionHostId ||
      stored.command !== args.command ||
      stored.epoch !== args.epoch ||
      stored.started_at_ms !== args.startedAtMs
    ) {
      throw new Error('Gate attempt natural key was replayed with different inputs')
    }
    return gateAttemptRecord(stored)
  })
}

export function completeGateAttempt(
  database: ObjectiveDatabase,
  args: CompleteGateAttemptArgs
): ObjectiveGateAttempt {
  return runObjectiveMutation(database, (db) => {
    if (!readGateAttemptRow(db, args.watcherId, args.gateName, args.contentIdentity)) {
      throw new Error('Gate attempt must be started before completion')
    }
    db.prepare(
      `UPDATE gate_attempt
       SET exit_code = ?, timed_out = ?, stdout_tail = ?, stderr_tail = ?, completed_at_ms = ?
       WHERE watcher_id = ? AND gate_name = ? AND content_identity = ? AND completed_at_ms IS NULL`
    ).run(
      args.exitCode,
      args.timedOut ? 1 : 0,
      args.stdoutTail,
      args.stderrTail,
      args.completedAtMs,
      args.watcherId,
      args.gateName,
      args.contentIdentity
    )
    const stored = readGateAttemptRow(db, args.watcherId, args.gateName, args.contentIdentity)
    if (
      !stored ||
      stored.exit_code !== args.exitCode ||
      (stored.timed_out === 1) !== args.timedOut ||
      stored.stdout_tail !== args.stdoutTail ||
      stored.stderr_tail !== args.stderrTail ||
      stored.completed_at_ms !== args.completedAtMs
    ) {
      throw new Error('Gate attempt natural key was replayed with a different result')
    }
    return gateAttemptRecord(stored)
  })
}

export function getGateAttempt(
  database: ObjectiveDatabase,
  watcherId: string,
  gateName: string,
  contentIdentity: string
): ObjectiveGateAttempt | null {
  const row = readGateAttemptRow(database.connection(), watcherId, gateName, contentIdentity)
  return row ? gateAttemptRecord(row) : null
}

export function listGateAttempts(
  database: ObjectiveDatabase,
  watcherId: string
): ObjectiveGateAttempt[] {
  const rows = database
    .connection()
    .prepare(
      `SELECT ${GATE_ATTEMPT_COLUMNS} FROM gate_attempt WHERE watcher_id = ?
       ORDER BY started_at_ms DESC, id DESC`
    )
    .all(watcherId) as unknown as GateAttemptRow[]
  return rows.map(gateAttemptRecord)
}

/** Read model rows for `ObjectiveProjectionSchema.gateAttempts`: the latest 64 by start time. */
export function projectGateAttempts(
  db: Database.Database,
  watcherId: string
): {
  gateName: string
  contentIdentity: string
  executionHostId: string
  command: string
  exitCode: number | null
  timedOut: boolean | null
  stdoutTail: string | null
  stderrTail: string | null
  startedAtMs: number
  completedAtMs: number | null
}[] {
  const rows = db
    .prepare(
      `SELECT ${GATE_ATTEMPT_COLUMNS} FROM gate_attempt WHERE watcher_id = ?
       ORDER BY started_at_ms DESC, id DESC LIMIT 64`
    )
    .all(watcherId) as unknown as GateAttemptRow[]
  return rows.map((row) => {
    const record = gateAttemptRecord(row)
    return {
      gateName: record.gateName,
      contentIdentity: record.contentIdentity,
      executionHostId: record.executionHostId,
      command: record.command,
      exitCode: record.exitCode,
      timedOut: record.timedOut,
      stdoutTail: record.stdoutTail,
      stderrTail: record.stderrTail,
      startedAtMs: record.startedAtMs,
      completedAtMs: record.completedAtMs
    }
  })
}
