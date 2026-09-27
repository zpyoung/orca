import { cloneLedger } from '../../shared/ledger-entry-snapshots'
import type {
  LedgerRecord,
  LedgerResponse,
  LedgerRuntimeIdentity,
  LedgerSummary
} from '../../shared/ledger'

export function summarizeLedger(
  record: LedgerRecord,
  runtime: LedgerRuntimeIdentity
): LedgerSummary {
  return {
    ledgerId: record.ledgerId,
    tier: record.tier,
    revision: record.revision,
    owner: cloneLedger(record.owner),
    formerOwner: cloneLedger(record.formerOwner),
    runtime: cloneLedger(runtime),
    entryCount: record.entries.length,
    nextSequence: record.nextSequence,
    staleAfterDays: record.staleAfterDays,
    sourceEquivalences: cloneLedger(record.sourceEquivalences)
  }
}

export function createLedgerResponse(
  record: LedgerRecord | null,
  runtime: LedgerRuntimeIdentity,
  extra: Partial<LedgerResponse>
): LedgerResponse {
  return cloneLedger({
    schemaVersion: 1,
    runtime,
    ledger: record ? summarizeLedger(record, runtime) : null,
    ...extra
  })
}
