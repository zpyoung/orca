import { translate } from '@/i18n/i18n'
import type { HeimdallApi } from '../../../shared/fork-heimdall/api'
import type { WatcherFleetEntry, WatcherTarget } from '../../../shared/fork-heimdall/fleet-types'
import type {
  ApprovalScope,
  EscalationEntry,
  WatcherLedger
} from '../../../shared/fork-heimdall/ledger-types'
import type { WatcherListEntry } from '../../../shared/fork-heimdall/watcher-types'
import type {
  HostedReviewEnrollmentPayload,
  HostedReviewSitterProvider
} from '../../../shared/fork-hosted-review-sitter/types'

export function getHeimdallApi(): HeimdallApi | null {
  const candidate: unknown = window.api?.heimdall
  if (!candidate || typeof candidate !== 'object') {
    return null
  }
  const methods = candidate as Partial<Record<keyof HeimdallApi, unknown>>
  if (
    typeof methods.fleet !== 'function' ||
    typeof methods.detail !== 'function' ||
    typeof methods.command !== 'function' ||
    typeof methods.enroll !== 'function' ||
    typeof methods.debugReport !== 'function'
  ) {
    return null
  }
  return candidate as HeimdallApi
}
export function isSupportedProvider(provider: string): provider is HostedReviewSitterProvider {
  return provider === 'github' || provider === 'gitlab'
}

function hostedReviewPayload(entry: WatcherListEntry): HostedReviewEnrollmentPayload | null {
  if (entry.enrollment.kind !== 'hosted-review') {
    return null
  }
  const payload = entry.enrollment.kindPayload
  if (!payload || typeof payload !== 'object') {
    return null
  }
  const candidate = payload as Partial<HostedReviewEnrollmentPayload>
  if (
    typeof candidate.branch !== 'string' ||
    (candidate.provider !== 'github' && candidate.provider !== 'gitlab') ||
    typeof candidate.reviewNumber !== 'number' ||
    typeof candidate.reviewUrl !== 'string' ||
    (candidate.branchUpdateMode !== 'merge-base-update' &&
      candidate.branchUpdateMode !== 'rebase') ||
    (candidate.mergeMethod !== null &&
      candidate.mergeMethod !== 'merge' &&
      candidate.mergeMethod !== 'squash' &&
      candidate.mergeMethod !== 'rebase')
  ) {
    return null
  }
  return candidate as HostedReviewEnrollmentPayload
}

export type HostedReviewSitterSelection = {
  repoId: string
  worktreeId: string | null
  reviewProvider: string
  reviewNumber: number
  owner: Pick<WatcherTarget, 'connectionId' | 'pairingRevision'>
}

export function sameHostedReview(
  row: WatcherFleetEntry,
  selection: HostedReviewSitterSelection
): boolean {
  const payload = hostedReviewPayload(row.entry)
  return (
    payload !== null &&
    row.entry.enrollment.repoId === selection.repoId &&
    row.entry.enrollment.worktreeId === selection.worktreeId &&
    payload.provider === selection.reviewProvider &&
    payload.reviewNumber === selection.reviewNumber &&
    row.target.connectionId === selection.owner.connectionId &&
    row.target.pairingRevision === selection.owner.pairingRevision
  )
}

function sameApprovalScope(left: ApprovalScope, right: ApprovalScope): boolean {
  return (
    left.actionKind === right.actionKind &&
    left.contentIdentity === right.contentIdentity &&
    left.evidenceKey === right.evidenceKey &&
    left.preparedCommitSha === right.preparedCommitSha
  )
}

export function awaitingApprovalScope(ledger: WatcherLedger | null): ApprovalScope | null {
  if (!ledger) {
    return null
  }
  const latestById = new Map<string, EscalationEntry>()
  for (const entry of ledger.entries) {
    if (entry.kind !== 'escalation') {
      continue
    }
    const previous = latestById.get(entry.escalationId)
    if (!previous || entry.atMs >= previous.atMs) {
      latestById.set(entry.escalationId, entry)
    }
  }
  const escalation =
    [...latestById.values()]
      .filter(
        (entry) =>
          entry.escalationKind === 'awaiting-approval' &&
          entry.status === 'open' &&
          entry.approvalScope
      )
      .sort((left, right) => right.atMs - left.atMs)[0] ?? null
  const scope = escalation?.approvalScope
  if (!escalation || !scope) {
    return null
  }
  const decided = ledger.entries.some(
    (entry) =>
      entry.kind === 'approval' &&
      entry.atMs >= escalation.atMs &&
      sameApprovalScope(entry.scope, scope)
  )
  return decided ? null : scope
}

export function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message
  }
  if (typeof error === 'string' && error.trim()) {
    return error
  }
  return translate(
    'fork.hostedReviewSitter.error.noResponse',
    'The PR Sitter service did not respond.'
  )
}
