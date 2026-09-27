import { translate } from '@/i18n/i18n'

import type { LedgerOwner, LedgerState, LedgerSummary } from '../../../../shared/ledger'
import { detachedTierLabel, tierLabel } from './ledger-tier-labels'

/**
 * Localized copy for the ledger page header, attach bar, and filter row.
 *
 * Composed sentences resolve to one catalog entry each so translators can move
 * the values around; filter labels shared with the sidebar deliberately reuse
 * the `ledger.panel.*` keys rather than duplicating a translation.
 */

export function controlsOpenLedger(): string {
  return translate('ledger.controls.open', 'Open ledger')
}

export function controlsSummaryLine(ledger: LedgerSummary): string {
  const tier = ledger.owner ? tierLabel(ledger.tier) : detachedTierLabel(ledger.tier)
  const options = { tier, count: ledger.entryCount, revision: ledger.revision }
  return ledger.entryCount === 1
    ? translate(
        'ledger.controls.summary_one',
        '{{tier}} · {{count}} entry · revision {{revision}}',
        options
      )
    : translate(
        'ledger.controls.summary_other',
        '{{tier}} · {{count}} entries · revision {{revision}}',
        options
      )
}

export function controlsRuntimeTitle(runtimeId: string, profileId: string): string {
  return translate(
    'ledger.controls.runtimeTitle',
    'runtime {{runtimeId}} · profile {{profileId}}',
    {
      runtimeId,
      profileId
    }
  )
}

export function controlsNoLedger(): string {
  return translate('ledger.controls.noLedger', 'This owner has no ledger yet.')
}

export function controlsSettings(): string {
  return translate('ledger.controls.settings', 'Ledger settings')
}

export function controlsRefresh(): string {
  return translate('ledger.controls.refresh', 'Refresh')
}

export function controlsTriage(): string {
  return translate('ledger.panel.triage', 'Triage')
}

export function controlsNewEntry(): string {
  return translate('ledger.panel.newEntry', 'New entry')
}

export function controlsDeleteLedger(): string {
  return translate('ledger.controls.deleteLedger', 'Delete ledger')
}

export function controlsDeleteLedgerConfirm(): string {
  return translate(
    'ledger.controls.deleteLedgerConfirm',
    'Permanently delete this ledger, every entry body, and all history?'
  )
}

export function controlsAttachmentOwner(): string {
  return translate('ledger.controls.attachmentOwner', 'Attachment owner')
}

export function controlsAttachPlaceholder(tier: LedgerOwner['tier']): string {
  return tier === 'project'
    ? translate('ledger.controls.attachProject', 'Attach project')
    : translate('ledger.controls.attachGroup', 'Attach group')
}

export function controlsAttach(): string {
  return translate('ledger.controls.attach', 'Attach')
}

export function controlsAttachConfirm(owner: string): string {
  return translate(
    'ledger.controls.attachConfirm',
    'Attach {{owner}}? Project attachment asserts the same codebase.',
    { owner }
  )
}

export function controlsSimilarEntries(): string {
  return translate('ledger.controls.similarEntries', 'Similar entries (advisory):')
}

export function controlsSearchEntries(): string {
  return translate('ledger.controls.searchEntries', 'Search entries')
}

export function controlsSearchPlaceholder(): string {
  return translate('ledger.panel.searchPlaceholder', 'Search title or ID')
}

export function controlsTypeFilter(): string {
  return translate('ledger.controls.typeFilter', 'Entry type filter')
}

export function controlsAllTypes(): string {
  return translate('ledger.panel.allTypes', 'All types')
}

export function controlsStateFilter(): string {
  return translate('ledger.controls.stateFilter', 'Entry state filter')
}

export function controlsAllStates(): string {
  return translate('ledger.panel.allStates', 'All states')
}

export function controlsReviewFilter(): string {
  return translate('ledger.controls.reviewFilter', 'Review filter')
}

export function controlsReviewedAll(): string {
  return translate('ledger.controls.reviewedAll', 'Reviewed: all')
}

export function controlsReviewed(): string {
  return translate('ledger.panel.reviewed', 'Reviewed')
}

export function controlsUnreviewed(): string {
  return translate('ledger.panel.unreviewed', 'Unreviewed')
}

export function controlsStaleFilter(): string {
  return translate('ledger.controls.staleFilter', 'Stale filter')
}

export function controlsStaleAll(): string {
  return translate('ledger.controls.staleAll', 'Stale: all')
}

export function controlsStale(): string {
  return translate('ledger.panel.stale', 'Stale')
}

export function controlsNotStale(): string {
  return translate('ledger.panel.notStale', 'Not stale')
}

export function controlsSortLabel(): string {
  return translate('ledger.controls.sortLabel', 'Entry sort')
}

export function controlsSortUpdated(): string {
  return translate('ledger.controls.sortUpdated', 'Newest activity')
}

export function controlsSortSequence(): string {
  return translate('ledger.controls.sortSequence', 'Sequence')
}

export function controlsSortTitle(): string {
  return translate('ledger.controls.sortTitle', 'Title')
}

export function controlsWorkspaceFilter(): string {
  return translate('ledger.controls.workspaceFilter', 'Origin workspace filter')
}

export function controlsWorkspacePlaceholder(): string {
  return translate('ledger.controls.workspacePlaceholder', 'Origin workspace')
}

export function controlsBranchFilter(): string {
  return translate('ledger.controls.branchFilter', 'Origin branch filter')
}

export function controlsBranchPlaceholder(): string {
  return translate('ledger.controls.branchPlaceholder', 'Origin branch')
}

export function controlsReviewSelected(count: number): string {
  return translate('ledger.controls.reviewSelected', 'Review ({{count}})', { count })
}

export function controlsBulkState(next: Extract<LedgerState, 'resolved' | 'archived'>): string {
  return next === 'resolved'
    ? translate('ledger.controls.resolveSelected', 'Resolve selected')
    : translate('ledger.controls.archiveSelected', 'Archive selected')
}

export function controlsBulkStateConfirm(
  count: number,
  next: Extract<LedgerState, 'resolved' | 'archived'>
): string {
  return next === 'resolved'
    ? translate(
        'ledger.controls.resolveSelectedConfirm',
        'Set {{count}} displayed entries to resolved?',
        { count }
      )
    : translate(
        'ledger.controls.archiveSelectedConfirm',
        'Set {{count}} displayed entries to archived?',
        { count }
      )
}

export function controlsDeleteSelected(): string {
  return translate('ledger.controls.deleteSelected', 'Delete selected')
}

export function controlsDeleteSelectedConfirm(count: number): string {
  return translate(
    'ledger.controls.deleteSelectedConfirm',
    'Permanently delete {{count}} entries and their histories?',
    { count }
  )
}
