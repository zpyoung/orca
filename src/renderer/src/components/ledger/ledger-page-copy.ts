import { translate } from '@/i18n/i18n'

/** Localized copy owned by the ledger page shell rather than one of its panels. */

export function pageStaleRevisions(message: string): string {
  return translate(
    'ledger.page.staleRevisions',
    '{{message}}. Review the refreshed revisions before confirming again.',
    { message }
  )
}

export function pageOwnerLedgerTitle(ownerName: string): string {
  return translate('ledger.page.ownerLedgerTitle', '{{ownerName}} ledger', { ownerName })
}
