import { translate } from '@/i18n/i18n'

import type { LedgerSummary } from '../../../../shared/ledger'
import { detachedTierLabel, tierLabel } from './ledger-tier-labels'

/** Localized copy for the ledger catalog picker. */

export function chooserTitle(): string {
  return translate('ledger.chooser.title', 'Open ledger')
}

export function chooserSubtitle(): string {
  return translate('ledger.chooser.subtitle', 'Attached and detached ledgers for this runtime')
}

export function chooserRuntimeLabel(): string {
  return translate('ledger.chooser.runtime', 'Ledger runtime')
}

export function chooserLocalRuntime(): string {
  return translate('ledger.chooser.localRuntime', 'Local runtime')
}

export function chooserRefresh(): string {
  return translate('ledger.chooser.refresh', 'Refresh')
}

export function chooserCatalogError(error: string): string {
  return translate(
    'ledger.chooser.catalogError',
    'Unsupported selected runtime or catalog unavailable: {{error}}',
    { error }
  )
}

export function chooserLoading(): string {
  return translate('ledger.chooser.loading', 'Loading ledger catalog…')
}

export function chooserEmpty(): string {
  return translate('ledger.chooser.empty', 'No ledgers exist for this runtime.')
}

export function chooserUnknownOwner(): string {
  return translate('ledger.chooser.unknownOwner', 'Unknown owner')
}

export function chooserSummaryLine(ledger: LedgerSummary): string {
  const tier = ledger.owner
    ? tierLabel(ledger.owner.tier)
    : detachedTierLabel(ledger.formerOwner?.tier ?? ledger.tier)
  const options = { tier, count: ledger.entryCount }
  return ledger.entryCount === 1
    ? translate('ledger.chooser.summary_one', '{{tier}} · {{count}} entry', options)
    : translate('ledger.chooser.summary_other', '{{tier}} · {{count}} entries', options)
}

export function chooserOpen(): string {
  return translate('ledger.chooser.open', 'Open')
}
