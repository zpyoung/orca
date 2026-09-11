import type { LedgerRemovalPreview } from '../../shared/ledger'

export type LedgerCatalogRemovalTarget = {
  repoId?: string
  projectGroupId?: string
  removeContainedProjects?: boolean
}

export type ExpectedLedgerRevision = { ledgerId: string; revision: number }

export type LedgerCatalogRemovalResult<T> = { result: T; ledgers: LedgerRemovalPreview[] }

/** Runs a catalog mutation under the ledger retention guard, reporting the ledgers it detached. */
export type LedgerCatalogRemoval = <T>(
  removal: LedgerCatalogRemovalTarget,
  expectedLedgers: ExpectedLedgerRevision[] | undefined,
  mutate: () => T
) => Promise<LedgerCatalogRemovalResult<T>>

export type DetachedLedgerRemoval = LedgerRemovalPreview & { detached: true }

export function markDetachedLedgers(ledgers: LedgerRemovalPreview[]): DetachedLedgerRemoval[] {
  return ledgers.map((item) => ({ ...item, detached: true as const }))
}
