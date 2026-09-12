import type { LedgerOwner } from '../../../../shared/ledger'
import { useLedgerOwnerLabels } from '../ledger/ledger-owner-labels'

export function useLedgerOwnerName(
  owner: LedgerOwner | null,
  environmentId: string | undefined,
  isVisible: boolean
): string | null {
  return useLedgerOwnerLabels(environmentId, isVisible && Boolean(owner)).lookup(owner)
}
