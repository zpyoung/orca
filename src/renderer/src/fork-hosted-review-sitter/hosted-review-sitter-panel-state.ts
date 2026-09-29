import { translate } from '@/i18n/i18n'
import type { HeimdallApi } from '../../../shared/fork-heimdall/api'
import type { WatcherFleetEntry, WatcherTarget } from '../../../shared/fork-heimdall/fleet-types'
import {
  getLatestEscalations,
  sameApprovalScope
} from '../../../shared/fork-heimdall/ledger-queries'
import type { ApprovalScope, WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import type { WatcherListEntry } from '../../../shared/fork-heimdall/watcher-types'
import type {
  HostedReviewEnrollmentPayload,
  HostedReviewMergeCheckScope,
  HostedReviewSitterProvider
} from '../../../shared/fork-hosted-review-sitter/types'

type HostedReviewEnrollmentPayloadIngress = Omit<
  HostedReviewEnrollmentPayload,
  'mergeCheckScope'
> & { mergeCheckScope?: HostedReviewMergeCheckScope }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isHeimdallApiBridge(value: Record<string, unknown>): value is HeimdallApi {
  return (
    typeof value.fleet === 'function' &&
    typeof value.detail === 'function' &&
    typeof value.command === 'function' &&
    typeof value.enroll === 'function' &&
    typeof value.debugReport === 'function'
  )
}

export function getHeimdallApi(): HeimdallApi | null {
  const candidate: unknown = window.api?.heimdall
  if (!isRecord(candidate)) {
    return null
  }
  return isHeimdallApiBridge(candidate) ? candidate : null
}
export function isSupportedProvider(provider: string): provider is HostedReviewSitterProvider {
  return provider === 'github' || provider === 'gitlab'
}

function isHostedReviewEnrollmentPayload(
  value: Record<string, unknown>
): value is HostedReviewEnrollmentPayloadIngress {
  return (
    typeof value.branch === 'string' &&
    (value.provider === 'github' || value.provider === 'gitlab') &&
    typeof value.reviewNumber === 'number' &&
    typeof value.reviewUrl === 'string' &&
    (value.branchUpdateMode === 'merge-base-update' || value.branchUpdateMode === 'rebase') &&
    (value.mergeMethod === null ||
      value.mergeMethod === 'merge' ||
      value.mergeMethod === 'squash' ||
      value.mergeMethod === 'rebase') &&
    (value.mergeCheckScope === undefined ||
      value.mergeCheckScope === 'required' ||
      value.mergeCheckScope === 'all')
  )
}

export function hostedReviewPayload(entry: WatcherListEntry): HostedReviewEnrollmentPayload | null {
  if (entry.enrollment.kind !== 'hosted-review') {
    return null
  }
  const payload = entry.enrollment.kindPayload
  if (!isRecord(payload) || !isHostedReviewEnrollmentPayload(payload)) {
    return null
  }
  return {
    branch: payload.branch,
    provider: payload.provider,
    reviewNumber: payload.reviewNumber,
    reviewUrl: payload.reviewUrl,
    branchUpdateMode: payload.branchUpdateMode,
    mergeMethod: payload.mergeMethod,
    mergeCheckScope: payload.mergeCheckScope ?? 'all'
  }
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

export function awaitingApprovalScope(ledger: WatcherLedger | null): ApprovalScope | null {
  if (!ledger) {
    return null
  }
  const escalation =
    getLatestEscalations(ledger)
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
