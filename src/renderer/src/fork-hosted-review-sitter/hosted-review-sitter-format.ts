import { translate } from '@/i18n/i18n'
import type {
  HostedReviewSitterActionKind,
  HostedReviewSitterActionState,
  HostedReviewSitterCapability,
  HostedReviewSitterCapabilityMode,
  HostedReviewSitterDiscrepancyKind,
  HostedReviewSitterDiscrepancyStatus,
  HostedReviewSitterLedgerEntry,
  HostedReviewSitterStatusState
} from '../../../shared/fork-hosted-review-sitter/types'

export function hostedReviewSitterActionLabel(action: HostedReviewSitterActionKind): string {
  switch (action) {
    case 'rerun-check':
      return translate('fork.hostedReviewSitter.action.rerunCheck', 'Re-run failed check')
    case 'prepare-fix':
      return translate('fork.hostedReviewSitter.action.prepareFix', 'Prepare check fix')
    case 'publish-fix':
      return translate('fork.hostedReviewSitter.action.publishFix', 'Publish check fix')
    case 'prepare-conflict-resolution':
      return translate(
        'fork.hostedReviewSitter.action.prepareConflictResolution',
        'Prepare conflict resolution'
      )
    case 'publish-conflict-resolution':
      return translate(
        'fork.hostedReviewSitter.action.publishConflictResolution',
        'Publish conflict resolution'
      )
    case 'update-branch':
      return translate('fork.hostedReviewSitter.action.updateBranch', 'Update branch')
    case 'merge':
      return translate('fork.hostedReviewSitter.action.merge', 'Merge review')
    case 'enqueue':
      return translate('fork.hostedReviewSitter.action.enqueue', 'Enter merge queue')
  }
}

function hostedReviewSitterActionStateLabel(state: HostedReviewSitterActionState): string {
  switch (state) {
    case 'attempted':
      return translate('fork.hostedReviewSitter.actionState.attempted', 'Attempted')
    case 'running':
      return translate('fork.hostedReviewSitter.actionState.running', 'Running')
    case 'completed':
      return translate('fork.hostedReviewSitter.actionState.completed', 'Completed')
    case 'failed':
      return translate('fork.hostedReviewSitter.actionState.failed', 'Failed')
  }
}

export function hostedReviewSitterDiscrepancyLabel(
  kind: HostedReviewSitterDiscrepancyKind
): string {
  switch (kind) {
    case 'check-failure':
      return translate('fork.hostedReviewSitter.discrepancy.checkFailure', 'Check failure')
    case 'merge-conflict':
      return translate('fork.hostedReviewSitter.discrepancy.mergeConflict', 'Merge conflict')
    case 'queue-ejected':
      return translate('fork.hostedReviewSitter.discrepancy.queueEjected', 'Merge queue ejection')
    case 'fix-did-not-resolve':
      return translate(
        'fork.hostedReviewSitter.discrepancy.fixDidNotResolve',
        'Fix did not resolve failure'
      )
    case 'ambiguous-action':
      return translate('fork.hostedReviewSitter.discrepancy.ambiguousAction', 'Ambiguous action')
    case 'unverifiable-failure':
      return translate(
        'fork.hostedReviewSitter.discrepancy.unverifiableFailure',
        'Unverifiable failure'
      )
    case 'awaiting-approval':
      return translate('fork.hostedReviewSitter.discrepancy.awaitingApproval', 'Awaiting approval')
  }
}

function hostedReviewSitterDiscrepancyStatusLabel(
  status: HostedReviewSitterDiscrepancyStatus
): string {
  switch (status) {
    case 'open':
      return translate('fork.hostedReviewSitter.discrepancyStatus.open', 'Open')
    case 'acknowledged':
      return translate('fork.hostedReviewSitter.discrepancyStatus.acknowledged', 'Acknowledged')
    case 'resolved':
      return translate('fork.hostedReviewSitter.discrepancyStatus.resolved', 'Resolved')
    case 'escalated':
      return translate('fork.hostedReviewSitter.discrepancyStatus.escalated', 'Escalated')
  }
}

export function hostedReviewSitterCapabilityLabel(
  capability: HostedReviewSitterCapability
): string {
  switch (capability) {
    case 'updateBranch':
      return translate('fork.hostedReviewSitter.capability.updateBranch', 'Update branch')
    case 'resolveConflicts':
      return translate('fork.hostedReviewSitter.capability.resolveConflicts', 'Resolve conflicts')
    case 'fixChecks':
      return translate('fork.hostedReviewSitter.capability.fixChecks', 'Fix checks')
    case 'merge':
      return translate('fork.hostedReviewSitter.capability.merge', 'Merge')
  }
}

export function hostedReviewSitterCapabilityModeLabel(
  mode: HostedReviewSitterCapabilityMode
): string {
  switch (mode) {
    case 'off':
      return translate('fork.hostedReviewSitter.capabilityMode.off', 'Off')
    case 'gated':
      return translate('fork.hostedReviewSitter.capabilityMode.gated', 'Ask')
    case 'on':
      return translate('fork.hostedReviewSitter.capabilityMode.on', 'On')
  }
}

export function hostedReviewSitterStatusLabel(state: HostedReviewSitterStatusState): string {
  switch (state) {
    case 'watching':
      return translate('fork.hostedReviewSitter.status.watching', 'Watching')
    case 'held':
      return translate('fork.hostedReviewSitter.status.held', 'Held')
    case 'acting':
      return translate('fork.hostedReviewSitter.status.acting', 'Acting')
    case 'escalated':
      return translate('fork.hostedReviewSitter.status.escalated', 'Escalated')
    case 'budget-exhausted':
      return translate('fork.hostedReviewSitter.status.budgetExhausted', 'Budget exhausted')
    case 'merged':
      return translate('fork.hostedReviewSitter.status.merged', 'Merged')
    case 'closed':
      return translate('fork.hostedReviewSitter.status.closed', 'Closed')
    case 'disabled':
      return translate('fork.hostedReviewSitter.status.disabled', 'Stopped')
  }
}

export function formatHostedReviewSitterDuration(milliseconds: number): string {
  const totalMinutes = Math.max(0, Math.ceil(milliseconds / 60_000))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) {
    return translate('fork.hostedReviewSitter.duration.minutes', '{{minutes}}m', { minutes })
  }
  if (minutes === 0) {
    return translate('fork.hostedReviewSitter.duration.hours', '{{hours}}h', { hours })
  }
  return translate('fork.hostedReviewSitter.duration.hoursMinutes', '{{hours}}h {{minutes}}m', {
    hours,
    minutes
  })
}

export function formatHostedReviewSitterTime(atMs: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(atMs)
}

export type HostedReviewSitterLedgerEntrySummary = {
  title: string
  detail: string | null
}

export function hostedReviewSitterLedgerEntrySummary(
  entry: HostedReviewSitterLedgerEntry
): HostedReviewSitterLedgerEntrySummary {
  switch (entry.kind) {
    case 'action': {
      let resultDetail: string | null = null
      if (entry.result?.kind === 'prepared') {
        resultDetail = translate(
          'fork.hostedReviewSitter.ledger.preparedCommit',
          'Prepared commit {{sha}}',
          { sha: entry.result.preparedCommitSha }
        )
      } else if (entry.result?.kind === 'published') {
        resultDetail = translate(
          'fork.hostedReviewSitter.ledger.resultingHead',
          'Resulting head {{sha}}',
          { sha: entry.result.resultingHeadSha }
        )
      } else if (entry.result?.kind === 'rerun-requested') {
        resultDetail = translate(
          'fork.hostedReviewSitter.ledger.rerunAccepted',
          'Provider accepted the re-run request'
        )
      }
      return {
        title: translate('fork.hostedReviewSitter.ledger.actionState', '{{action}} · {{state}}', {
          action: hostedReviewSitterActionLabel(entry.action.kind),
          state: hostedReviewSitterActionStateLabel(entry.state)
        }),
        detail: entry.reason ?? resultDetail
      }
    }
    case 'approval': {
      const action = hostedReviewSitterActionLabel(entry.scope.action)
      return {
        title:
          entry.decision === 'approved'
            ? translate('fork.hostedReviewSitter.ledger.approvedAction', 'Approved {{action}}', {
                action
              })
            : translate('fork.hostedReviewSitter.ledger.rejectedAction', 'Rejected {{action}}', {
                action
              }),
        detail: entry.scope.preparedCommitSha
          ? translate('fork.hostedReviewSitter.ledger.preparedCommit', 'Prepared commit {{sha}}', {
              sha: entry.scope.preparedCommitSha
            })
          : translate('fork.hostedReviewSitter.ledger.head', 'Head {{sha}}', {
              sha: entry.scope.headSha
            })
      }
    }
    case 'discrepancy':
      return {
        title: translate(
          'fork.hostedReviewSitter.ledger.discrepancyState',
          '{{kind}} · {{state}}',
          {
            kind: hostedReviewSitterDiscrepancyLabel(entry.discrepancyKind),
            state: hostedReviewSitterDiscrepancyStatusLabel(entry.status)
          }
        ),
        detail:
          entry.reason ??
          translate('fork.hostedReviewSitter.ledger.head', 'Head {{sha}}', {
            sha: entry.headSha
          })
      }
    case 'fix-attribution':
      return {
        title: translate(
          'fork.hostedReviewSitter.ledger.fixPublished',
          'Fix published for {{check}}',
          { check: entry.checkKey }
        ),
        detail: translate(
          'fork.hostedReviewSitter.ledger.fixHeads',
          'Prepared {{preparedSha}}; resulting head {{headSha}}',
          { preparedSha: entry.preparedCommitSha, headSha: entry.producedHeadSha }
        )
      }
    case 'active-time':
      return {
        title: translate(
          'fork.hostedReviewSitter.ledger.activeTime',
          'Recorded {{duration}} active time',
          { duration: formatHostedReviewSitterDuration(entry.activeMs) }
        ),
        detail:
          entry.source === 'tick'
            ? translate('fork.hostedReviewSitter.ledger.checkpoint', 'Periodic checkpoint')
            : entry.source === 'pause'
              ? translate('fork.hostedReviewSitter.ledger.paused', 'Paused')
              : translate('fork.hostedReviewSitter.ledger.shutdown', 'Orca closed')
      }
    case 'lifecycle':
      return {
        title:
          entry.state === 'merged'
            ? translate('fork.hostedReviewSitter.ledger.reviewMerged', 'Review merged')
            : translate('fork.hostedReviewSitter.ledger.reviewClosed', 'Review closed'),
        detail: translate('fork.hostedReviewSitter.ledger.head', 'Head {{sha}}', {
          sha: entry.headSha
        })
      }
  }
}
