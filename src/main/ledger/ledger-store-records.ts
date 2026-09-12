import { randomUUID } from 'node:crypto'
import { cloneLedger } from '../../shared/ledger-entry-snapshots'
import type { LedgerOwner, LedgerRecord, LedgerRuntimeIdentity } from '../../shared/ledger'

export function createLedgerRecord(
  owner: LedgerOwner,
  runtime: LedgerRuntimeIdentity
): LedgerRecord {
  return {
    ledgerId: randomUUID(),
    tier: owner.tier,
    revision: 0,
    owner,
    formerOwner: null,
    runtime,
    entryCount: 0,
    nextSequence: 1,
    staleAfterDays: 90,
    sourceEquivalences: [],
    entries: [],
    importAnchors: {},
    metadataHistory: []
  }
}

export function findDetachedLedger(
  records: Map<string, LedgerRecord>,
  owner: LedgerOwner,
  findLedger: (owner: LedgerOwner) => LedgerRecord | null
): LedgerRecord | null {
  if (owner.tier !== 'project') {
    return null
  }
  const candidates = Array.from(records.values()).filter(
    (record) =>
      !record.owner && record.formerOwner?.tier === owner.tier && record.formerOwner.id === owner.id
  )
  return candidates.length === 1 && !findLedger(owner) ? cloneLedger(candidates[0]) : null
}
