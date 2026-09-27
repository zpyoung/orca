import type { LedgerEntry, LedgerReviewCandidate } from './ledger'
export function isLedgerEntryStale(entry: LedgerEntry, now: Date, staleAfterDays = 90): boolean {
  return now.getTime() - Date.parse(entry.updatedAt) > staleAfterDays * 86400000
}
export function triageLedgerEntries(
  entries: readonly LedgerEntry[],
  now: Date,
  staleAfterDays = 90
): LedgerReviewCandidate[] {
  return entries
    .map((entry) => ({
      entry,
      stale: isLedgerEntryStale(entry, now, staleAfterDays),
      reason: entry.reviewed ? 'reviewed' : 'unreviewed'
    }))
    .sort((a, b) => {
      const band = (x: LedgerReviewCandidate) => (x.entry.reviewed ? 2 : 0) + (x.stale ? 0 : 1)
      const difference = band(a) - band(b)
      if (difference) {
        return difference
      }
      const unverified = (x: LedgerEntry) =>
        x.latestContentActor.kind === 'unknown' ||
        (x.latestContentActor.kind === 'import' &&
          x.latestContentActor.initiator?.kind === 'unknown')
      const actorDifference = Number(unverified(b.entry)) - Number(unverified(a.entry))
      if (actorDifference) {
        return actorDifference
      }
      return (
        Date.parse(a.entry.updatedAt) - Date.parse(b.entry.updatedAt) ||
        a.entry.sequence - b.entry.sequence
      )
    })
}
