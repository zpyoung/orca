import { cloneLedger } from '../../shared/ledger-entry-snapshots'
import { canonicalizeLedgerImportAnchors } from '../../shared/ledger-source-identity'
import {
  LedgerError,
  type LedgerMutationContext,
  type LedgerOwner,
  type LedgerRecord,
  type LedgerRequest,
  type LedgerResponse
} from '../../shared/ledger'

type AttachmentDependencies = {
  now: () => string
  findLedger: (owner: LedgerOwner) => LedgerRecord | null
  commit: (record: LedgerRecord) => void
  response: (record: LedgerRecord | null, extra: Partial<LedgerResponse>) => LedgerResponse
}

export function attachLedger(
  record: LedgerRecord,
  request: LedgerRequest,
  context: LedgerMutationContext,
  dependencies: AttachmentDependencies
): LedgerResponse {
  if (context.channel !== 'ui' || request.confirmed !== true) {
    throw new LedgerError('confirmation-required', 'Attachment requires UI confirmation')
  }
  if (request.ifLedgerRevision !== record.revision) {
    throw new LedgerError('conflict', 'Ledger revision is stale', {
      currentRevision: record.revision
    })
  }
  const target = request.attachTo
  if (!target || record.owner || target.tier !== record.tier || !context.ownerIsLive?.(target)) {
    throw new LedgerError(
      'attachment-refused',
      'A live same-tier target and detached ledger are required'
    )
  }
  if (dependencies.findLedger(target)) {
    throw new LedgerError('attachment-refused', 'Target owner already has a ledger')
  }
  const before = { owner: record.owner, sourceEquivalences: cloneLedger(record.sourceEquivalences) }
  if (record.tier === 'project' && record.formerOwner && record.formerOwner.id !== target.id) {
    const equivalences = [...record.sourceEquivalences, [record.formerOwner.id, target.id]]
    if (canonicalizeLedgerImportAnchors(record.importAnchors, equivalences).collision) {
      throw new LedgerError(
        'attachment-refused',
        'Source equivalence would collapse import anchors'
      )
    }
    record.sourceEquivalences = equivalences
  }
  record.owner = cloneLedger(target)
  record.revision++
  record.metadataHistory.push({
    revision: record.revision,
    at: dependencies.now(),
    actor: context.actor,
    before,
    after: { owner: record.owner, sourceEquivalences: cloneLedger(record.sourceEquivalences) },
    changedFields: ['owner', 'sourceEquivalences']
  })
  dependencies.commit(record)
  return dependencies.response(record, {})
}
