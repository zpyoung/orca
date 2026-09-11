import { translate } from '@/i18n/i18n'

import type { LedgerReviewCandidate } from '../../../../shared/ledger'

/**
 * Localized copy for the operation-review dialog.
 *
 * Lives beside the component so the composed sentences stay single catalog
 * entries: translators need the whole line, not the `·`-joined fragments the
 * JSX used to interleave with values.
 */

export function triageTitle(): string {
  return translate('ledger.triage.title', 'Operation review')
}

export function triageDescription(): string {
  return translate(
    'ledger.triage.description',
    'Advisory triage for the selected runtime, target, and filters. No entries are auto-resolved.'
  )
}

export function triageLoading(): string {
  return translate('ledger.triage.loading', 'Loading review candidates…')
}

export function triageEmpty(): string {
  return translate('ledger.triage.empty', 'No review candidates match these filters.')
}

export function triageCandidatesLabel(): string {
  return translate('ledger.triage.candidates', 'Review candidates')
}

export function triageSelectEntryLabel(id: string, revision: number): string {
  return translate('ledger.triage.selectEntry', 'Select {{id}} revision {{revision}}', {
    id,
    revision
  })
}

export function triageStaleBadge(): string {
  return translate('ledger.triage.staleBadge', 'stale')
}

export function triageUnavailable(): string {
  return translate('ledger.triage.unavailable', 'unavailable')
}

export function triageReasonLine(candidate: LedgerReviewCandidate): string {
  return translate(
    'ledger.triage.reasonLine',
    'Reason: {{reason}} · current state: {{state}} · revision {{revision}} · updated {{updated}}',
    {
      reason: candidate.reason,
      state: candidate.entry.state,
      revision: candidate.entry.revision,
      updated: new Date(candidate.entry.updatedAt).toLocaleString()
    }
  )
}

export function triageOriginLine(candidate: LedgerReviewCandidate): string {
  const evidence = candidate.evidence
  const unavailable = triageUnavailable()
  return translate(
    'ledger.triage.originLine',
    'Origin baseline: {{baseline}} · observed revision: {{observedRevision}} · observed time: {{observedAt}} · file: {{file}}',
    {
      baseline: candidate.entry.origin.revision ?? unavailable,
      observedRevision: evidence?.observedRevision ?? unavailable,
      observedAt: evidence?.observedAt
        ? new Date(evidence.observedAt).toLocaleString()
        : unavailable,
      file:
        evidence?.fileExists === undefined
          ? unavailable
          : evidence.fileExists
            ? translate('ledger.triage.filePresent', 'present')
            : translate('ledger.triage.fileMissing', 'missing')
    }
  )
}

export function triageEvidenceLine(candidate: LedgerReviewCandidate): string {
  const evidence = candidate.evidence
  const note = evidence?.available
    ? (evidence.note ?? translate('ledger.triage.evidenceAvailable', 'available'))
    : (evidence?.note ?? triageUnavailable())
  return translate('ledger.triage.evidenceLine', 'Evidence: {{note}}', { note })
}

export function triageAdvisoryNote(): string {
  return translate(
    'ledger.triage.advisory',
    'This review is advisory. It never resolves, archives, or otherwise changes entries without an explicit action and confirmation.'
  )
}

export function triageClose(): string {
  return translate('ledger.triage.close', 'Close')
}

export function triageCancel(): string {
  return translate('ledger.triage.cancel', 'Cancel')
}

export function triageApprove(selectedCount: number): string {
  return selectedCount
    ? translate('ledger.triage.approveSelected', 'Approve review ({{count}})', {
        count: selectedCount
      })
    : translate('ledger.triage.approve', 'Approve review')
}

export function triageResolve(): string {
  return translate('ledger.triage.resolve', 'Resolve')
}

export function triageArchive(): string {
  return translate('ledger.triage.archive', 'Archive')
}

export function triageConfirmAction(state: 'resolved' | 'archived' | undefined): string {
  return state === 'archived'
    ? translate('ledger.triage.confirmArchive', 'Confirm archive')
    : translate('ledger.triage.confirmResolve', 'Confirm resolve')
}

export function triageBulkDescription(): string {
  return translate(
    'ledger.triage.bulkDescription',
    'This bulk action requires confirmation and will use the listed immutable id/revision snapshots.'
  )
}

export function triageConfirmRow(id: string, title: string, revision: number): string {
  return translate('ledger.triage.confirmRow', '{{id}} · {{title}} · revision {{revision}}', {
    id,
    title,
    revision
  })
}

export function triageHiddenSelections(): string {
  return translate(
    'ledger.triage.hiddenSelections',
    'Some selected entries are no longer displayed; they will not be acted on.'
  )
}
