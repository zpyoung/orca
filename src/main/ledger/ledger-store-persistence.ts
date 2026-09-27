import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { bestEffortFsyncDirectorySync, writeDurableSecureJsonFile } from '../../shared/secure-file'
import { cloneLedger } from '../../shared/ledger-entry-snapshots'
import { validateLedgerStoreRecord } from '../../shared/ledger-record-validation'
import { canonicalizeLedgerImportAnchors } from '../../shared/ledger-source-identity'
import { LedgerError, type LedgerRecord, type LedgerRuntimeIdentity } from '../../shared/ledger'

const STORE_VERSION = 1

export function loadLedgerRecords(
  directory: string,
  runtime: LedgerRuntimeIdentity
): Map<string, LedgerRecord> {
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Map()
    }
    throw new LedgerError('incompatible-store', 'Ledger store directory is unreadable', {
      cause: String(error)
    })
  }
  const loaded = new Map<string, LedgerRecord>()
  for (const name of names) {
    if (!name.startsWith('ledger-') || !name.endsWith('.json')) {
      continue
    }
    let value: unknown
    try {
      value = JSON.parse(readFileSync(join(directory, name), 'utf8'))
    } catch (error) {
      throw new LedgerError('incompatible-store', 'Ledger store is unreadable', {
        path: name,
        cause: String(error)
      })
    }
    const record = value as LedgerRecord
    const encoded = name.slice('ledger-'.length, -'.json'.length)
    let filenameId: string
    try {
      filenameId = decodeURIComponent(encoded)
    } catch {
      throw new LedgerError('incompatible-store', 'Ledger filename is malformed', { path: name })
    }
    if (
      !record ||
      (record as unknown as { version?: unknown }).version !== STORE_VERSION ||
      record.ledgerId !== filenameId ||
      record.runtime?.profileId !== runtime.profileId ||
      !Array.isArray(record.entries)
    ) {
      throw new LedgerError(
        'incompatible-store',
        'Ledger store is malformed, unsupported, or belongs to another runtime',
        { path: name }
      )
    }
    validateLedgerStoreRecord(record)
    const canonical = canonicalizeLedgerImportAnchors(
      record.importAnchors,
      record.sourceEquivalences
    )
    if (canonical.collision) {
      throw new LedgerError('incompatible-store', 'Import anchor collision', {
        anchor: canonical.collision
      })
    }
    if (loaded.has(record.ledgerId)) {
      throw new LedgerError('incompatible-store', 'Duplicate ledger identity', {
        ledgerId: record.ledgerId
      })
    }
    loaded.set(record.ledgerId, record)
  }
  const owners = new Set<string>()
  for (const record of loaded.values()) {
    if (!record.owner) {
      continue
    }
    const key = `${record.owner.tier}:${record.owner.id}`
    if (owners.has(key)) {
      throw new LedgerError('incompatible-store', 'Duplicate owner binding', { owner: key })
    }
    owners.add(key)
  }
  return new Map([...loaded].map(([id, record]) => [id, cloneLedger(record)]))
}

export function persistLedgerRecord(directory: string, record: LedgerRecord): LedgerRecord {
  record.entryCount = record.entries.length
  const next = cloneLedger(record)
  validateLedgerStoreRecord({ version: STORE_VERSION, ...next })
  writeDurableSecureJsonFile(join(directory, `ledger-${encodeURIComponent(next.ledgerId)}.json`), {
    version: STORE_VERSION,
    ...next
  })
  return next
}

export function ledgerRecordPath(directory: string, id: string): string {
  return join(directory, `ledger-${encodeURIComponent(id)}.json`)
}

export function syncLedgerDirectory(directory: string): void {
  bestEffortFsyncDirectorySync(directory)
}
