import { areCurrentHeadRequiredChecksGreen } from './decision'
import {
  approvalScopeForAction,
  getActionDisposition,
  getActiveTimeMs,
  getAmbiguousActions,
  getInFlightActions,
  getLatestActionTransitions,
  getLatestApproval,
  getLatestDiscrepancies,
  makeEvidenceKey
} from './ledger'
import { hasRepeatedFailureAfterOwnFix, hasUnverifiableReproducedFailure } from './stop-policy'
import type {
  ActionApprovalScope,
  ActionLedgerEntry,
  HostedReviewCheckSnapshot,
  HostedReviewSitterAction,
  HostedReviewSitterContention,
  HostedReviewSitterDefinition,
  HostedReviewSitterGateDecision,
  HostedReviewSitterLedger,
  HostedReviewSnapshot,
  PrepareConflictResolutionAction,
  PrepareFixAction
} from './types'

const ALLOW: HostedReviewSitterGateDecision = { verdict: 'allow' }

function sameScope(left: ActionApprovalScope, right: ActionApprovalScope): boolean {
  return (
    left.action === right.action &&
    left.headSha === right.headSha &&
    left.evidenceKey === right.evidenceKey &&
    left.preparedCommitSha === right.preparedCommitSha
  )
}

function hasAcknowledgedScope(
  ledger: HostedReviewSitterLedger,
  scope: ActionApprovalScope
): boolean {
  return [...getLatestDiscrepancies(ledger).values()].some(
    (entry) =>
      entry.status === 'acknowledged' &&
      Boolean(entry.approvalScope && sameScope(entry.approvalScope, scope))
  )
}

function currentChecksForAction(
  review: HostedReviewSnapshot,
  action: PrepareFixAction
): readonly HostedReviewCheckSnapshot[] {
  const expectedObservations = new Set(action.observationIds)
  return review.checks.filter(
    (check) =>
      check.required &&
      check.headSha === review.headSha &&
      check.checkKey === action.checkKey &&
      expectedObservations.has(check.observationId)
  )
}

function isPrepareFixEvidenceCurrent(
  review: HostedReviewSnapshot,
  action: PrepareFixAction
): boolean {
  const current = currentChecksForAction(review, action)
  if (current.length !== action.observationIds.length) {
    return false
  }
  return current.every(
    (check) => check.state === 'failed' && check.failureSignature === action.failureSignature
  )
}

function completedPreparation(
  ledger: HostedReviewSitterLedger,
  actionId: string,
  preparedCommitSha: string,
  expectedKind: PrepareFixAction['kind'] | PrepareConflictResolutionAction['kind']
): ActionLedgerEntry | null {
  const entry = getLatestActionTransitions(ledger).find(
    (candidate) => candidate.actionId === actionId
  )
  if (
    !entry ||
    entry.state !== 'completed' ||
    entry.action.kind !== expectedKind ||
    entry.result?.kind !== 'prepared' ||
    entry.result.preparedCommitSha !== preparedCommitSha
  ) {
    return null
  }
  return entry
}

function isActionEvidenceCurrent(
  action: HostedReviewSitterAction,
  review: HostedReviewSnapshot,
  ledger: HostedReviewSitterLedger
): boolean {
  if (action.headSha !== review.headSha) {
    return false
  }

  if (action.kind === 'rerun-check') {
    const expected = new Set(action.observationIds)
    const current = review.checks.filter(
      (check) =>
        check.required &&
        check.headSha === review.headSha &&
        check.checkKey === action.checkKey &&
        expected.has(check.observationId)
    )
    return (
      current.length === action.observationIds.length &&
      current.every((check) => check.state === 'failed')
    )
  }

  if (action.kind === 'prepare-fix') {
    return isPrepareFixEvidenceCurrent(review, action)
  }

  if (action.kind === 'publish-fix') {
    const preparation = completedPreparation(
      ledger,
      action.preparationActionId,
      action.preparedCommitSha,
      'prepare-fix'
    )
    return (
      preparation?.action.kind === 'prepare-fix' &&
      preparation.action.headSha === action.headSha &&
      preparation.action.checkKey === action.checkKey &&
      preparation.action.failureSignature === action.failureSignature &&
      isPrepareFixEvidenceCurrent(review, preparation.action)
    )
  }

  if (action.kind === 'prepare-conflict-resolution') {
    return review.conflicts === 'present' && review.baseSha === action.baseSha
  }

  if (action.kind === 'publish-conflict-resolution') {
    const preparation = completedPreparation(
      ledger,
      action.preparationActionId,
      action.preparedCommitSha,
      'prepare-conflict-resolution'
    )
    return (
      preparation?.action.kind === 'prepare-conflict-resolution' &&
      preparation.action.headSha === action.headSha &&
      preparation.action.baseSha === action.baseSha &&
      review.conflicts === 'present' &&
      review.baseSha === action.baseSha
    )
  }

  if (action.kind === 'update-branch') {
    return review.behindBase && review.conflicts === 'none' && review.baseSha === action.baseSha
  }

  const mergeGatesCurrent =
    review.freshness === 'live' &&
    review.lifecycle === 'open' &&
    !review.draft &&
    review.conflicts === 'none' &&
    areCurrentHeadRequiredChecksGreen(review) &&
    review.providerReadiness.verdict === 'ready'
  if (!mergeGatesCurrent) {
    return false
  }
  const currentObservations = review.checks
    .filter((check) => check.required && check.headSha === review.headSha)
    .map((check) => check.observationId)
    .sort()
  if (action.kind === 'enqueue') {
    const expectedEvidence = makeEvidenceKey(['enqueue', review.headSha, ...currentObservations])
    return (
      action.evidenceKey === expectedEvidence &&
      review.queue.required &&
      review.queue.membership === 'not-enqueued'
    )
  }
  const expectedEvidence = makeEvidenceKey([
    'merge',
    review.headSha,
    action.mergeMethod,
    ...currentObservations
  ])
  return (
    action.evidenceKey === expectedEvidence &&
    !review.queue.required &&
    review.queue.membership === 'not-enqueued'
  )
}

function gatedCapabilityDecision(
  action: HostedReviewSitterAction,
  sitter: HostedReviewSitterDefinition,
  ledger: HostedReviewSitterLedger
): HostedReviewSitterGateDecision {
  const mode = sitter.capabilities[action.capability]
  if (mode === 'off') {
    return action.capability === 'resolveConflicts'
      ? { verdict: 'escalate', reason: 'conflict-resolution-disabled' }
      : { verdict: 'hold', reason: 'capability-off' }
  }
  if (mode === 'on') {
    return ALLOW
  }
  if (action.kind === 'prepare-fix' || action.kind === 'prepare-conflict-resolution') {
    return ALLOW
  }

  const scope = approvalScopeForAction(action)
  const approval = getLatestApproval(ledger, scope)
  if (approval?.decision === 'rejected') {
    return { verdict: 'escalate', reason: 'approval-rejected' }
  }
  if (approval?.decision === 'approved' || hasAcknowledgedScope(ledger, scope)) {
    return ALLOW
  }
  return { verdict: 'hold', reason: 'awaiting-approval' }
}

function contentionDecision(
  contention: HostedReviewSitterContention
): HostedReviewSitterGateDecision {
  switch (contention.state) {
    case 'clear':
      return ALLOW
    case 'dirty':
      return { verdict: 'hold', reason: 'local-changes' }
    case 'foreign-agent':
      return { verdict: 'hold', reason: 'foreign-agent' }
    case 'sitter-fix-agent':
      return { verdict: 'hold', reason: 'action-in-flight' }
    case 'unverifiable':
      return { verdict: 'hold', reason: 'contention-unverifiable' }
    case 'abandoned-sitter-fix':
      return { verdict: 'escalate', reason: 'abandoned-fix' }
  }
}

export function gateDesiredAction(
  action: HostedReviewSitterAction,
  review: HostedReviewSnapshot,
  sitter: HostedReviewSitterDefinition,
  ledger: HostedReviewSitterLedger,
  contention: HostedReviewSitterContention
): HostedReviewSitterGateDecision {
  if (!sitter.enabled) {
    return { verdict: 'hold', reason: 'sitter-disabled' }
  }
  if (
    review.provider !== sitter.provider ||
    review.reviewNumber !== sitter.reviewNumber ||
    review.url !== sitter.reviewUrl
  ) {
    return { verdict: 'escalate', reason: 'review-identity-mismatch' }
  }
  if (review.lifecycle !== 'open') {
    return { verdict: 'hold', reason: 'review-not-open' }
  }
  if (getActiveTimeMs(ledger) >= sitter.activeBudgetMs) {
    return { verdict: 'escalate', reason: 'budget-exhausted' }
  }
  if (hasRepeatedFailureAfterOwnFix(review, ledger)) {
    return { verdict: 'escalate', reason: 'stop-signature-repeated' }
  }
  if (hasUnverifiableReproducedFailure(review, ledger)) {
    return { verdict: 'escalate', reason: 'failure-signature-unavailable' }
  }
  const escalated = [...getLatestDiscrepancies(ledger).values()].some(
    (entry) => entry.headSha === review.headSha && entry.status === 'escalated'
  )
  if (escalated) {
    return { verdict: 'escalate', reason: 'discrepancy-escalated' }
  }

  const disposition = getActionDisposition(ledger, action.key)
  if (disposition === 'completed') {
    return { verdict: 'hold', reason: 'already-completed' }
  }
  if (disposition === 'in-flight') {
    return { verdict: 'hold', reason: 'action-in-flight' }
  }
  if (disposition === 'ambiguous' || getAmbiguousActions(ledger).length > 0) {
    return { verdict: 'escalate', reason: 'ambiguous-action' }
  }
  if (getInFlightActions(ledger).length > 0) {
    return { verdict: 'hold', reason: 'action-in-flight' }
  }
  if (!isActionEvidenceCurrent(action, review, ledger)) {
    return { verdict: 'hold', reason: 'stale-evidence' }
  }

  const capability = gatedCapabilityDecision(action, sitter, ledger)
  if (capability.verdict !== 'allow') {
    return capability
  }
  return contentionDecision(contention)
}
