import { translate } from '@/i18n/i18n'

/**
 * Localized copy for the "ledger records retained" notice that the folder-removal
 * and group-deletion dialogs both render before a destructive confirm.
 */

export function retentionTitle(): string {
  return translate('ledger.retention.title', 'Ledger records retained')
}

export function retentionChecking(): string {
  return translate('ledger.retention.checking', 'Checking affected ledgers…')
}

export function retentionNone(): string {
  return translate('ledger.retention.none', 'No affected ledgers.')
}

export function retentionSummary(entryCount: number, ledgerCount: number): string {
  const options = { entryCount, count: ledgerCount }
  return ledgerCount === 1
    ? translate(
        'ledger.retention.summary_one',
        '{{entryCount}} entries across {{count}} ledger will be retained and detached as needed.',
        options
      )
    : translate(
        'ledger.retention.summary_other',
        '{{entryCount}} entries across {{count}} ledgers will be retained and detached as needed.',
        options
      )
}
