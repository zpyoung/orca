import type { LedgerResponse } from '../../shared/ledger'

function identity(value: LedgerResponse): string {
  const ledger = value.ledger
  return `runtime ${value.runtime.runtimeId} profile ${value.runtime.profileId}${ledger ? ` ledger ${ledger.ledgerId}` : ''}`
}

export function formatLedgerResponse(value: LedgerResponse): string {
  const prefix = identity(value)
  if (value.entry) {
    const entry = value.entry
    const history =
      entry.history
        .map(
          (change) => `  r${change.revision} ${change.at} fields:${change.changedFields.join(',')}`
        )
        .join('\n') || '  (none)'
    const matches = value.matches?.length
      ? `\nnear matches: ${value.matches.map((match) => match.id).join(', ')}`
      : ''
    return `${prefix}\n${entry.id} [${entry.type}] revision ${entry.revision} state ${entry.state} reviewed ${entry.reviewed}\ncontent: ${JSON.stringify(entry.content)}\norigin: ${JSON.stringify(entry.origin)}\nhistory:\n${history}${matches}`
  }
  if (value.entries) {
    const rows = value.entries.map(
      (entry) =>
        `${entry.id} [${entry.type}] ${String(entry.content.title ?? '')} (${entry.state}, r${entry.revision}, reviewed:${entry.reviewed})`
    )
    const matches = value.matches?.length
      ? `\nnear matches: ${value.matches.map((entry) => entry.id).join(', ')}`
      : ''
    return `${prefix}\n${rows.join('\n') || '(no ledger entries)'}${matches}`
  }
  if (value.candidates) {
    const rows = value.candidates.map(
      (candidate) =>
        `${candidate.entry.id}: ${candidate.reason}${candidate.evidence ? ` [evidence: ${candidate.evidence.available ? 'available' : 'unavailable'}${candidate.evidence.note ? `, ${candidate.evidence.note}` : ''}]` : ''}`
    )
    return `${prefix}\n${rows.join('\n') || '(no review candidates)'}`
  }
  if (value.importResult) {
    const result = value.importResult
    const skips = result.skipped
      .map((skip) => `  skipped ${skip.anchor ?? '(unknown)'}: ${skip.reason}`)
      .join('\n')
    return `${prefix}\ncreated ${result.created.length}, updated ${result.updated.length}, already present ${result.alreadyPresent.length}, skipped ${result.skipped.length}${skips ? `\n${skips}` : ''}`
  }
  return `${prefix}\n${JSON.stringify(value)}`
}
