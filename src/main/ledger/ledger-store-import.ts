import { applyLedgerImportRecord, type LedgerImportApplyResult } from './ledger-import-record'
import { cloneLedger } from '../../shared/ledger-entry-snapshots'
import {
  LedgerError,
  type LedgerImportResult,
  type LedgerMutationContext,
  type LedgerRecord,
  type LedgerResponse
} from '../../shared/ledger'
type ImportDependencies = {
  now: () => string
  commit: (record: LedgerRecord) => void
  response: (record: LedgerRecord | null, extra: Partial<LedgerResponse>) => LedgerResponse
  hasRecord: (id: string) => boolean
}

export function reconcileLedgerImports(
  record: LedgerRecord,
  context: LedgerMutationContext,
  dependencies: ImportDependencies
): LedgerResponse {
  const result: LedgerImportResult = {
    created: [],
    updated: [],
    alreadyPresent: [],
    skipped: cloneLedger(context.importSkipped ?? [])
  }
  for (const source of context.importRecords ?? []) {
    const next = cloneLedger(record)
    let applied: LedgerImportApplyResult
    try {
      applied = applyLedgerImportRecord(next, source, context, dependencies.now())
    } catch (error) {
      if (!(error instanceof LedgerError)) {
        throw error
      }
      result.skipped.push({
        anchor: source.anchor,
        sourcePath: source.sourcePath,
        reason: error.message
      })
      continue
    }
    if (applied.changed) {
      try {
        dependencies.commit(next)
      } catch (error) {
        throw new LedgerError('storage-failed', 'Import commit failed', {
          cause: String(error),
          importResult: cloneLedger(result)
        })
      }
      record = next
    }
    if (applied.status === 'skipped') {
      result.skipped.push({
        anchor: source.anchor,
        sourcePath: source.sourcePath,
        reason: applied.reason ?? 'skipped'
      })
    } else if (applied.status === 'created') {
      result.created.push(applied.entryId!)
    } else if (applied.status === 'updated') {
      result.updated.push(applied.entryId!)
    } else {
      result.alreadyPresent.push(applied.entryId!)
    }
  }
  return dependencies.response(dependencies.hasRecord(record.ledgerId) ? record : null, {
    importResult: result
  })
}
