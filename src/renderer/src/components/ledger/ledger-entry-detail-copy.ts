import { translate } from '@/i18n/i18n'

import type { LedgerChange, LedgerEntry } from '../../../../shared/ledger'

/** Localized copy for the entry detail dialog and its revision history list. */

export function detailHistoryRevision(revision: number): string {
  return translate('ledger.detail.historyRevision', 'revision {{revision}}', { revision })
}

export function detailChangedFields(change: LedgerChange): string {
  const fields = change.changedFields.length
    ? change.changedFields.join(', ')
    : translate('ledger.detail.changedNone', 'none')
  return translate('ledger.detail.changedFields', 'Changed: {{fields}}', { fields })
}

export function detailBefore(): string {
  return translate('ledger.detail.before', 'Before')
}

export function detailAfter(): string {
  return translate('ledger.detail.after', 'After')
}

export function detailReviewedBadge(): string {
  return translate('ledger.detail.reviewedBadge', 'reviewed')
}

export function detailSummaryLine(entry: LedgerEntry): string {
  return translate(
    'ledger.detail.summaryLine',
    'Revision {{revision}} · sequence {{sequence}} · updated {{updated}}',
    {
      revision: entry.revision,
      sequence: entry.sequence,
      updated: new Date(entry.updatedAt).toLocaleString()
    }
  )
}

export function detailEntrySection(): string {
  return translate('ledger.detail.entrySection', 'Entry')
}

export function detailOriginSection(): string {
  return translate('ledger.detail.originSection', 'Origin')
}

export function detailContentSection(): string {
  return translate('ledger.detail.contentSection', 'Content')
}

export function detailLatestActor(): string {
  return translate('ledger.detail.latestActor', 'Latest content actor')
}

export function detailModel(): string {
  return translate('ledger.detail.model', 'model')
}

export function detailProviderSession(): string {
  return translate('ledger.detail.providerSession', 'provider session')
}

export function detailFullHistory(): string {
  return translate('ledger.detail.fullHistory', 'Full history')
}

export function detailRevisionCount(count: number): string {
  return count === 1
    ? translate('ledger.detail.revisionCount_one', '{{count}} revision', { count })
    : translate('ledger.detail.revisionCount_other', '{{count}} revisions', { count })
}

export function detailEdit(): string {
  return translate('ledger.detail.edit', 'Edit')
}

export function detailReview(): string {
  return translate('ledger.detail.review', 'Review')
}

export function detailRevertLabel(): string {
  return translate('ledger.detail.revertLabel', 'Revision to revert to')
}

export function detailRevertPlaceholder(): string {
  return translate('ledger.detail.revertPlaceholder', 'Revert to…')
}

export function detailRevisionOption(revision: number): string {
  return translate('ledger.detail.revisionOption', 'Revision {{revision}}', { revision })
}

export function detailRevert(): string {
  return translate('ledger.detail.revert', 'Revert')
}

export function detailClose(): string {
  return translate('ledger.detail.close', 'Close')
}
