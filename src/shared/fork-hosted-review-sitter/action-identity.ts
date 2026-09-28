import { makeAttemptFingerprint } from '../fork-heimdall/attempt-fingerprint'
import type { ApprovalScope } from '../fork-heimdall/ledger-types'
import type { HostedReviewSitterAction, HostedReviewSnapshot } from './types'

/** Stable JSON encoding for kind-owned evidence components. */
export function makeHostedReviewEvidenceKey(parts: readonly (string | number | null)[]): string {
  return JSON.stringify(parts)
}

export function hostedReviewContentIdentity(review: HostedReviewSnapshot): string {
  return makeHostedReviewEvidenceKey([review.headSha, review.baseSha])
}

export function hostedReviewAttemptFingerprint(action: HostedReviewSitterAction): string {
  return makeAttemptFingerprint(action.contentIdentity, action.kind, action.evidenceKey)
}

export function approvalScopeForHostedReviewAction(
  action: HostedReviewSitterAction
): ApprovalScope {
  const preparedCommitSha =
    action.kind === 'publish-fix' || action.kind === 'publish-conflict-resolution'
      ? action.preparedCommitSha
      : undefined
  return {
    actionKind: action.kind,
    contentIdentity: action.contentIdentity,
    evidenceKey: action.evidenceKey,
    ...(preparedCommitSha === undefined ? {} : { preparedCommitSha })
  }
}
