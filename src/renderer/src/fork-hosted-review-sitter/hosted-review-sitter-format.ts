import { translate } from '@/i18n/i18n'
import type { LedgerEntry } from '../../../shared/fork-heimdall/ledger-types'
import type {
  CapabilityMode,
  WatcherStatusState
} from '../../../shared/fork-heimdall/watcher-types'
import type {
  HostedReviewSitterActionKind,
  HostedReviewSitterCapability,
  HostedReviewSitterDiscrepancyKind,
  HostedReviewSitterDiscrepancyStatus,
  HostedReviewSitterActionResult,
  HostedReviewFixAttribution
} from '../../../shared/fork-hosted-review-sitter/types'

const HOSTED_REVIEW_ACTION_KINDS: Record<HostedReviewSitterActionKind, true> = {
  'rerun-check': true,
  'prepare-fix': true,
  'publish-fix': true,
  'prepare-conflict-resolution': true,
  'publish-conflict-resolution': true,
  'update-branch': true,
  merge: true,
  enqueue: true
}

function isHostedReviewActionKind(action: string): action is HostedReviewSitterActionKind {
  return HOSTED_REVIEW_ACTION_KINDS[action as HostedReviewSitterActionKind] === true
}

const HOSTED_REVIEW_DISCREPANCY_KINDS: Record<HostedReviewSitterDiscrepancyKind, true> = {
  'check-failure': true,
  'merge-conflict': true,
  'queue-ejected': true,
  'fix-did-not-resolve': true,
  'unresolved-action': true,
  'unverifiable-failure': true,
  'awaiting-approval': true
}

function isHostedReviewDiscrepancyKind(kind: string): kind is HostedReviewSitterDiscrepancyKind {
  return HOSTED_REVIEW_DISCREPANCY_KINDS[kind as HostedReviewSitterDiscrepancyKind] === true
}

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
    case 'unresolved-action':
      return translate(
        'fork.hostedReviewSitter.discrepancy.unresolvedAction',
        'Indeterminate action'
      )
    case 'unverifiable-failure':
      return translate(
        'fork.hostedReviewSitter.discrepancy.unverifiableFailure',
        'Unverifiable failure'
      )
    case 'awaiting-approval':
      return translate('fork.hostedReviewSitter.discrepancy.awaitingApproval', 'Awaiting approval')
  }
}

export function hostedReviewSitterKernelDiscrepancyLabel(kind: string): string {
  return isHostedReviewDiscrepancyKind(kind) ? hostedReviewSitterDiscrepancyLabel(kind) : kind
}

export function hostedReviewSitterDiscrepancyStatusLabel(
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

export function hostedReviewSitterCapabilityModeLabel(mode: CapabilityMode): string {
  switch (mode) {
    case 'off':
      return translate('fork.hostedReviewSitter.capabilityMode.off', 'Off')
    case 'gated':
      return translate('fork.hostedReviewSitter.capabilityMode.gated', 'Ask')
    case 'on':
      return translate('fork.hostedReviewSitter.capabilityMode.on', 'On')
  }
}

export function hostedReviewSitterStatusLabel(state: WatcherStatusState): string {
  switch (state) {
    case 'watching':
      return translate('fork.hostedReviewSitter.status.watching', 'Watching')
    case 'held':
      return translate('fork.hostedReviewSitter.status.held', 'Held')
    case 'acting':
      return translate('fork.hostedReviewSitter.status.acting', 'Acting')
    case 'escalated':
      return translate('fork.hostedReviewSitter.status.escalated', 'Escalated')
    case 'parked':
      return translate('fork.hostedReviewSitter.status.parked', 'Parked')
    case 'terminal':
      return translate('fork.hostedReviewSitter.status.terminal', 'Complete')
    case 'disabled':
      return translate('fork.hostedReviewSitter.status.disabled', 'Stopped')
    case 'unreachable':
      return translate('fork.hostedReviewSitter.status.unreachable', 'Host unreachable')
  }
}

export function formatHostedReviewSitterDuration(milliseconds: number): string {
  // Active-time checkpoints are sub-minute; rounding them up read as a full minute each.
  if (milliseconds < 60_000) {
    return translate('fork.hostedReviewSitter.duration.seconds', '{{seconds}}s', {
      seconds: Math.max(0, Math.ceil(milliseconds / 1_000))
    })
  }
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

export function hostedReviewSitterKernelActionLabel(actionKind: string): string {
  return isHostedReviewActionKind(actionKind)
    ? hostedReviewSitterActionLabel(actionKind)
    : actionKind
}

function resultDetail(result: unknown): string | null {
  if (!result || typeof result !== 'object' || !('kind' in result)) {
    return null
  }
  const actionResult = result as HostedReviewSitterActionResult
  if (actionResult.kind === 'worker-dispatched') {
    return translate(
      'fork.hostedReviewSitter.ledger.workerDispatched',
      'Worker dispatched: {{id}}',
      { id: actionResult.dispatchId }
    )
  }
  if (actionResult.kind === 'published') {
    return translate('fork.hostedReviewSitter.ledger.resultingHead', 'Resulting head {{sha}}', {
      sha: actionResult.resultingHeadSha
    })
  }
  if (actionResult.kind === 'rerun-requested') {
    return translate(
      'fork.hostedReviewSitter.ledger.rerunAccepted',
      'Provider accepted the re-run request'
    )
  }
  return null
}

function isFixAttribution(value: unknown): value is HostedReviewFixAttribution {
  if (!value || typeof value !== 'object') {
    return false
  }
  const candidate = value as Partial<HostedReviewFixAttribution>
  return (
    typeof candidate.preparedCommitSha === 'string' &&
    typeof candidate.producedHeadSha === 'string' &&
    typeof candidate.checkKey === 'string'
  )
}

export function hostedReviewSitterLedgerEntrySummary(
  entry: LedgerEntry
): HostedReviewSitterLedgerEntrySummary {
  switch (entry.kind) {
    case 'attempt':
      return {
        title: translate(
          `fork.hostedReviewSitter.ledger.${entry.state}`,
          `${entry.state === 'settled' ? 'Finished' : entry.state === 'running' ? 'Running' : 'Attempted'} {{action}}`,
          { action: hostedReviewSitterKernelActionLabel(entry.action.kind) }
        ),
        detail:
          entry.reason ??
          resultDetail(entry.result) ??
          (entry.effect
            ? translate('fork.hostedReviewSitter.ledger.outcome', 'Outcome: {{effect}}', {
                effect: entry.effect
              })
            : null)
      }
    case 'attempt-resolved':
      return {
        title: translate(
          'fork.hostedReviewSitter.ledger.attemptResolved',
          'Resolved {{effect}} action outcome',
          { effect: entry.effect }
        ),
        detail: null
      }
    case 'attempt-abandoned':
      return {
        title: translate(
          'fork.hostedReviewSitter.ledger.attemptAbandoned',
          'Abandoned action decision'
        ),
        detail: entry.detail ?? entry.reason
      }
    case 'approval':
      return {
        title:
          entry.decision === 'approved'
            ? translate('fork.hostedReviewSitter.ledger.approvedAction', 'Approved {{action}}', {
                action: hostedReviewSitterKernelActionLabel(entry.scope.actionKind)
              })
            : translate('fork.hostedReviewSitter.ledger.rejectedAction', 'Rejected {{action}}', {
                action: hostedReviewSitterKernelActionLabel(entry.scope.actionKind)
              }),
        detail: entry.scope.preparedCommitSha
          ? translate('fork.hostedReviewSitter.ledger.preparedCommit', 'Prepared commit {{sha}}', {
              sha: entry.scope.preparedCommitSha
            })
          : null
      }
    case 'escalation':
      return {
        title:
          entry.escalationKind === 'awaiting-approval' && entry.approvalScope
            ? translate(
                'fork.hostedReviewSitter.ledger.approvalRequested',
                'Approval requested for {{action}}',
                { action: hostedReviewSitterKernelActionLabel(entry.approvalScope.actionKind) }
              )
            : hostedReviewSitterKernelDiscrepancyLabel(entry.escalationKind),
        detail:
          entry.foldCount > 1
            ? translate(
                'fork.hostedReviewSitter.ledger.approvalFolded',
                'Requested {{count}} times',
                { count: entry.foldCount }
              )
            : (entry.reason ?? null)
      }
    case 'evidence':
      if (entry.evidenceKind === 'fix-attribution' && isFixAttribution(entry.payload)) {
        return {
          title: translate(
            'fork.hostedReviewSitter.ledger.fixPublished',
            'Fix published for {{check}}',
            {
              check: entry.payload.checkKey
            }
          ),
          detail: translate(
            'fork.hostedReviewSitter.ledger.fixHeads',
            'Prepared {{preparedSha}}; resulting head {{headSha}}',
            {
              preparedSha: entry.payload.preparedCommitSha,
              headSha: entry.payload.producedHeadSha
            }
          )
        }
      }
      return {
        title: translate('fork.hostedReviewSitter.ledger.evidence', 'Recorded {{kind}} evidence', {
          kind: entry.evidenceKind
        }),
        detail: null
      }
    case 'interval-open':
      return {
        title: translate(
          'fork.hostedReviewSitter.ledger.intervalOpen',
          'Active-time interval started'
        ),
        detail: entry.cause
      }
    case 'interval-checkpoint':
      return {
        title: translate(
          'fork.hostedReviewSitter.ledger.intervalCheckpoint',
          'Active-time checkpoint'
        ),
        detail: null
      }
    case 'interval-close':
      return {
        title: translate(
          'fork.hostedReviewSitter.ledger.intervalClose',
          'Active-time interval ended'
        ),
        detail: entry.closeReason
      }
    case 'turn':
      return {
        title: translate('fork.hostedReviewSitter.ledger.turn', 'Worker dispatched'),
        detail: entry.dispatchKind
      }
    case 'client-observation':
      return {
        title: translate('fork.hostedReviewSitter.ledger.clientObservation', 'Client observation'),
        detail: entry.detail ?? entry.what
      }
    case 'terminal':
      return {
        title: translate('fork.hostedReviewSitter.ledger.terminal', 'Watcher completed'),
        detail: `${entry.state}: ${entry.reason}`
      }
  }
}
