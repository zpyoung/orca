import type { LedgerEntry, LedgerFilters } from '../../shared/ledger'
import { isSameWorkspaceId } from '../../shared/workspace-scope'

export function ledgerEntryMatches(
  entry: LedgerEntry,
  filters: LedgerFilters | undefined,
  now: Date,
  threshold = 90
): boolean {
  if (!filters) {
    return true
  }
  const stale = now.getTime() - Date.parse(entry.updatedAt) > threshold * 24 * 60 * 60 * 1000
  return (
    (!filters.type || entry.type === filters.type) &&
    (!filters.state || entry.state === filters.state) &&
    (filters.reviewed === undefined || entry.reviewed === filters.reviewed) &&
    (filters.stale === undefined || stale === filters.stale) &&
    (filters.workspaceId === undefined ||
      isSameWorkspaceId(entry.origin.workspaceId, filters.workspaceId)) &&
    (filters.branch === undefined || entry.origin.branch === filters.branch)
  )
}
