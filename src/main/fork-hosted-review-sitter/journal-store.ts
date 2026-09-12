import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  HostedReviewSitterLedger,
  HostedReviewSitterLedgerEntry
} from '../../shared/fork-hosted-review-sitter/types'
import Database from '../sqlite/sync-database'
import { hardenSqliteDatabaseFiles } from '../sqlite/harden-database-files'

const JOURNAL_DIRECTORY = 'fork-hosted-review-sitter'
const JOURNAL_FILE = 'ledger.db'
const JOURNAL_SCHEMA_VERSION = 1
const JOURNAL_BUSY_TIMEOUT_MS = 5_000
const MAX_LEDGER_ENTRY_BYTES = 512 * 1024

const CREATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS hosted_review_sitter_ledger (
  sitter_id  TEXT    NOT NULL,
  seq        INTEGER NOT NULL,
  event_id   TEXT    NOT NULL,
  at_ms      INTEGER NOT NULL,
  entry_json TEXT    NOT NULL,
  PRIMARY KEY (sitter_id, seq),
  UNIQUE (event_id)
);
`

function pragmaNumber(db: Database.Database, name: string): number {
  return Number(db.pragma(name, { simple: true }) ?? 0)
}

function openDatabase(path: string): { db: Database.Database; readOnly: boolean } {
  const probe = new Database(path)
  let storedVersion: number
  try {
    storedVersion = pragmaNumber(probe, 'user_version')
  } catch (error) {
    probe.close()
    throw error
  }
  if (storedVersion > JOURNAL_SCHEMA_VERSION) {
    probe.close()
    return {
      db: new Database(path, { readonly: true, fileMustExist: true }),
      readOnly: true
    }
  }
  let transferred = false
  try {
    probe.pragma('journal_mode = WAL')
    probe.pragma(`busy_timeout = ${JOURNAL_BUSY_TIMEOUT_MS}`)
    probe.pragma('synchronous = FULL')
    if (storedVersion < JOURNAL_SCHEMA_VERSION) {
      probe.exec('BEGIN IMMEDIATE')
      try {
        probe.exec(CREATE_SCHEMA_SQL)
        probe.pragma(`user_version = ${JOURNAL_SCHEMA_VERSION}`)
        probe.exec('COMMIT')
      } catch (error) {
        probe.exec('ROLLBACK')
        throw error
      }
    }
    hardenSqliteDatabaseFiles(path)
    transferred = true
    return { db: probe, readOnly: false }
  } finally {
    if (!transferred) {
      probe.close()
    }
  }
}

function parseStoredEntry(row: unknown): HostedReviewSitterLedgerEntry {
  if (
    typeof row !== 'object' ||
    row === null ||
    !('entry_json' in row) ||
    typeof row.entry_json !== 'string'
  ) {
    throw new Error('Hosted review sitter ledger row has no JSON payload')
  }
  const untrustedEntry: unknown = JSON.parse(row.entry_json)
  if (
    typeof untrustedEntry !== 'object' ||
    untrustedEntry === null ||
    !('kind' in untrustedEntry) ||
    typeof untrustedEntry.kind !== 'string' ||
    !('eventId' in untrustedEntry) ||
    typeof untrustedEntry.eventId !== 'string' ||
    !('atMs' in untrustedEntry) ||
    typeof untrustedEntry.atMs !== 'number'
  ) {
    throw new Error('Hosted review sitter ledger row is malformed')
  }
  return untrustedEntry as HostedReviewSitterLedgerEntry
}

export class HostedReviewSitterJournalStore {
  private readonly db: Database.Database
  private readonly readOnly: boolean
  private readonly nextSequenceBySitter = new Map<string, number>()
  private closed = false

  constructor(profileStorageDirectory: string) {
    const journalDirectory = join(profileStorageDirectory, JOURNAL_DIRECTORY)
    mkdirSync(journalDirectory, { recursive: true, mode: 0o700 })
    const opened = openDatabase(join(journalDirectory, JOURNAL_FILE))
    this.db = opened.db
    this.readOnly = opened.readOnly
  }

  read(sitterId: string): HostedReviewSitterLedger {
    if (this.closed) {
      throw new Error('Hosted review sitter ledger is closed')
    }
    const rows = this.db
      .prepare(
        `SELECT entry_json FROM hosted_review_sitter_ledger
         WHERE sitter_id = ? ORDER BY seq ASC`
      )
      .all(sitterId)
    return { sitterId, entries: rows.map(parseStoredEntry) }
  }

  append(sitterId: string, entry: HostedReviewSitterLedgerEntry): void {
    if (this.closed) {
      throw new Error('Hosted review sitter ledger is closed')
    }
    if (this.readOnly) {
      throw new Error('Hosted review sitter ledger was created by a newer Orca build')
    }
    if (!sitterId || !entry.eventId || !Number.isSafeInteger(entry.atMs) || entry.atMs < 0) {
      throw new Error('Invalid hosted review sitter ledger entry')
    }
    const entryJson = JSON.stringify(entry)
    if (Buffer.byteLength(entryJson, 'utf8') > MAX_LEDGER_ENTRY_BYTES) {
      throw new Error('Hosted review sitter ledger entry is too large')
    }
    let nextSequence = this.nextSequenceBySitter.get(sitterId)
    if (nextSequence === undefined) {
      const row = this.db
        .prepare(
          `SELECT COALESCE(MAX(seq), 0) AS max_seq
           FROM hosted_review_sitter_ledger WHERE sitter_id = ?`
        )
        .get(sitterId) as { max_seq?: number } | undefined
      nextSequence = Number(row?.max_seq ?? 0) + 1
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(
          `INSERT INTO hosted_review_sitter_ledger
           (sitter_id, seq, event_id, at_ms, entry_json) VALUES (?, ?, ?, ?, ?)`
        )
        .run(sitterId, nextSequence, entry.eventId, entry.atMs, entryJson)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.nextSequenceBySitter.set(sitterId, nextSequence + 1)
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.db.close()
  }
}
