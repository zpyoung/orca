import { cloneLedger } from '../../shared/ledger-entry-snapshots'
import type { LedgerOwner, LedgerRecord } from '../../shared/ledger'

type OwnerRecoveryDependencies = {
  now: () => string
  findLedger: (owner: LedgerOwner) => LedgerRecord | null
  commit: (record: LedgerRecord) => void
}

export function reconcileLedgerOwners(
  records: Map<string, LedgerRecord>,
  liveOwners: readonly LedgerOwner[],
  dependencies: OwnerRecoveryDependencies
): void {
  const live = new Set(liveOwners.map((owner) => `${owner.tier}:${owner.id}`))
  for (const record of records.values()) {
    if (!record.owner || live.has(`${record.owner.tier}:${record.owner.id}`)) {
      continue
    }
    const next = cloneLedger(record)
    next.formerOwner = next.owner
    next.owner = null
    next.revision++
    next.metadataHistory.push({
      revision: next.revision,
      at: dependencies.now(),
      actor: { kind: 'unknown', model: null, providerSessionId: null },
      before: { owner: record.owner },
      after: { owner: null },
      changedFields: ['owner', 'formerOwner']
    })
    dependencies.commit(next)
  }
  for (const owner of liveOwners) {
    if (owner.tier !== 'project' || dependencies.findLedger(owner)) {
      continue
    }
    const candidates = Array.from(records.values()).filter(
      (record) =>
        !record.owner &&
        record.formerOwner?.tier === 'project' &&
        record.formerOwner.id === owner.id
    )
    if (candidates.length !== 1) {
      continue
    }
    const next = cloneLedger(candidates[0])
    next.owner = cloneLedger(owner)
    next.revision++
    next.metadataHistory.push({
      revision: next.revision,
      at: dependencies.now(),
      actor: { kind: 'unknown', model: null, providerSessionId: null },
      before: { owner: null },
      after: { owner },
      changedFields: ['owner']
    })
    dependencies.commit(next)
  }
}
