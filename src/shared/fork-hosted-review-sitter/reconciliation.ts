import { areCurrentHeadRequiredChecksGreen, computeDesiredAction } from './decision'
import { gateDesiredAction } from './gating'
import {
  approvalScopeForAction,
  getActiveTimeMs,
  getAmbiguousActions,
  getInFlightActions,
  getLatestActionTransitions,
  getLatestApproval,
  getLatestDiscrepancies,
  getRemainingBudgetMs,
  makeEvidenceKey
} from './ledger'
import { getRepeatedFailureAfterOwnFixEvidence, hasRepeatedFailureAfterOwnFix } from './stop-policy'
import type {
  DerivedHostedReviewSitterDiscrepancy,
  HostedReviewSitterAction,
  HostedReviewCheckSnapshot,
  HostedReviewSitterContention,
  HostedReviewSitterDefinition,
  HostedReviewSitterDiscrepancyKind,
  HostedReviewSitterDiscrepancyStatus,
  HostedReviewSitterLedger,
  HostedReviewSitterStatus,
  HostedReviewSnapshot,
  RerunCheckAction
} from './types'

type DiscrepancyDraft = {
  kind: HostedReviewSitterDiscrepancyKind
  evidenceKey: string
  headSha: string
  defaultStatus: HostedReviewSitterDiscrepancyStatus
  reason: string
}

function discrepancyId(draft: DiscrepancyDraft): string {
  return makeEvidenceKey([draft.kind, draft.headSha, draft.evidenceKey])
}

function currentStatus(
  draft: DiscrepancyDraft,
  ledger: HostedReviewSitterLedger
): HostedReviewSitterDiscrepancyStatus {
  const previous = getLatestDiscrepancies(ledger).get(discrepancyId(draft))
  if (!previous || previous.status === 'resolved') {
    return draft.defaultStatus
  }
  return previous.status
}

function toDerived(
  draft: DiscrepancyDraft,
  ledger: HostedReviewSitterLedger
): DerivedHostedReviewSitterDiscrepancy {
  return {
    id: discrepancyId(draft),
    kind: draft.kind,
    evidenceKey: draft.evidenceKey,
    headSha: draft.headSha,
    status: currentStatus(draft, ledger),
    reason: draft.reason
  }
}

function currentRequiredFailures(
  review: HostedReviewSnapshot
): readonly HostedReviewCheckSnapshot[] {
  return review.checks.filter(
    (check) => check.required && check.headSha === review.headSha && check.state === 'failed'
  )
}

function checkFailureDrafts(review: HostedReviewSnapshot): readonly DiscrepancyDraft[] {
  const unique = new Map<string, HostedReviewCheckSnapshot>()
  for (const check of currentRequiredFailures(review)) {
    const identity = makeEvidenceKey([
      check.checkKey,
      check.failureSignature,
      check.failureSignature ? null : check.observationId
    ])
    const previous = unique.get(identity)
    if (!previous || check.observationId.localeCompare(previous.observationId) < 0) {
      unique.set(identity, check)
    }
  }
  return [...unique.values()].map((check) => {
    const evidenceKey = makeEvidenceKey([
      check.checkKey,
      check.failureSignature,
      check.failureSignature ? null : check.observationId
    ])
    return {
      kind: 'check-failure',
      evidenceKey,
      headSha: review.headSha,
      defaultStatus: 'open',
      reason: `required-check-failed:${check.checkKey}`
    }
  })
}

function latestCompletedReruns(ledger: HostedReviewSitterLedger): readonly RerunCheckAction[] {
  return getLatestActionTransitions(ledger)
    .filter((entry) => entry.state === 'completed' && entry.action.kind === 'rerun-check')
    .map((entry) => entry.action as RerunCheckAction)
}

function unverifiableFailureDrafts(
  review: HostedReviewSnapshot,
  ledger: HostedReviewSitterLedger
): readonly DiscrepancyDraft[] {
  const drafts: DiscrepancyDraft[] = []
  for (const rerun of latestCompletedReruns(ledger)) {
    if (rerun.headSha !== review.headSha) {
      continue
    }
    const original = new Set(rerun.observationIds)
    const freshFailures = currentRequiredFailures(review).filter(
      (check) => check.checkKey === rerun.checkKey && !original.has(check.observationId)
    )
    if (freshFailures.length === 0 || freshFailures.some((check) => check.failureSignature)) {
      continue
    }
    const evidenceKey = makeEvidenceKey([
      rerun.checkKey,
      ...freshFailures.map((check) => check.observationId).sort()
    ])
    drafts.push({
      kind: 'unverifiable-failure',
      evidenceKey,
      headSha: review.headSha,
      defaultStatus: 'escalated',
      reason: `failure-signature-unavailable:${rerun.checkKey}`
    })
  }
  return drafts
}

function repeatedFixDrafts(
  review: HostedReviewSnapshot,
  ledger: HostedReviewSitterLedger
): readonly DiscrepancyDraft[] {
  return getRepeatedFailureAfterOwnFixEvidence(review, ledger).map((evidence) => ({
    kind: 'fix-did-not-resolve',
    evidenceKey: makeEvidenceKey([
      evidence.sourceHeadSha,
      evidence.producedHeadSha,
      evidence.checkKey,
      evidence.failureSignature,
      evidence.publishActionId
    ]),
    headSha: review.headSha,
    defaultStatus: 'escalated',
    reason: `same-failure-after-own-fix:${evidence.checkKey}`
  }))
}

function ambiguousActionDrafts(
  review: HostedReviewSnapshot,
  ledger: HostedReviewSitterLedger,
  contention?: HostedReviewSitterContention
): readonly DiscrepancyDraft[] {
  const ambiguous = [...getAmbiguousActions(ledger)]
  if (contention) {
    for (const entry of getInFlightActions(ledger)) {
      const isKnownLiveFix =
        contention.state === 'sitter-fix-agent' &&
        contention.actionId === entry.actionId &&
        entry.action.headSha === review.headSha
      if (!isKnownLiveFix) {
        ambiguous.push(entry)
      }
    }
  }

  return ambiguous.map((entry) => ({
    kind: 'ambiguous-action',
    evidenceKey: makeEvidenceKey([entry.action.key, entry.actionId]),
    headSha: entry.action.headSha,
    defaultStatus: 'escalated',
    reason: `action-outcome-ambiguous:${entry.action.kind}`
  }))
}

function activeDrafts(
  review: HostedReviewSnapshot,
  ledger: HostedReviewSitterLedger,
  contention?: HostedReviewSitterContention
): readonly DiscrepancyDraft[] {
  const drafts: DiscrepancyDraft[] = [
    ...repeatedFixDrafts(review, ledger),
    ...ambiguousActionDrafts(review, ledger, contention),
    ...unverifiableFailureDrafts(review, ledger),
    ...checkFailureDrafts(review)
  ]
  if (review.conflicts === 'present') {
    drafts.push({
      kind: 'merge-conflict',
      evidenceKey: makeEvidenceKey([review.headSha, review.baseSha]),
      headSha: review.headSha,
      defaultStatus: 'open',
      reason: 'merge-conflicts-detected'
    })
  }
  if (review.queue.required && review.queue.membership === 'ejected') {
    drafts.push({
      kind: 'queue-ejected',
      evidenceKey: makeEvidenceKey([review.headSha]),
      headSha: review.headSha,
      defaultStatus: 'escalated',
      reason: 'merge-queue-ejected'
    })
  }
  return drafts
}

export function deriveHostedReviewSitterDiscrepancies(
  review: HostedReviewSnapshot,
  ledger: HostedReviewSitterLedger,
  contention?: HostedReviewSitterContention
): readonly DerivedHostedReviewSitterDiscrepancy[] {
  const active = activeDrafts(review, ledger, contention)
  const activeIds = new Set(active.map(discrepancyId))
  const derived = active.map((draft) => toDerived(draft, ledger))

  for (const previous of getLatestDiscrepancies(ledger).values()) {
    if (
      previous.status === 'resolved' ||
      previous.discrepancyKind === 'awaiting-approval' ||
      activeIds.has(previous.discrepancyId)
    ) {
      continue
    }
    derived.push({
      id: previous.discrepancyId,
      kind: previous.discrepancyKind,
      evidenceKey: previous.evidenceKey,
      headSha: previous.headSha,
      status: 'resolved',
      reason: 'evidence-no-longer-present'
    })
  }

  return derived.sort((left, right) => left.id.localeCompare(right.id))
}

export function deriveActionApprovalDiscrepancy(
  action: HostedReviewSitterAction,
  ledger: HostedReviewSitterLedger
): DerivedHostedReviewSitterDiscrepancy {
  const scope = approvalScopeForAction(action)
  const evidenceKey = makeEvidenceKey([
    scope.action,
    scope.headSha,
    scope.evidenceKey,
    scope.preparedCommitSha ?? null
  ])
  const id = makeEvidenceKey(['awaiting-approval', action.headSha, evidenceKey])
  const approval = getLatestApproval(ledger, scope)
  const previous = getLatestDiscrepancies(ledger).get(id)
  const status =
    approval?.decision === 'rejected'
      ? 'escalated'
      : approval?.decision === 'approved'
        ? 'acknowledged'
        : previous && previous.status !== 'resolved'
          ? previous.status
          : 'open'
  return {
    id,
    kind: 'awaiting-approval',
    evidenceKey,
    headSha: action.headSha,
    status,
    approvalScope: scope,
    reason: approval ? `approval-${approval.decision}` : 'awaiting-approval'
  }
}

function idleReason(review: HostedReviewSnapshot): string | null {
  if (!review.checksComplete) {
    return 'checks-unverifiable'
  }
  if (review.queue.required && review.queue.membership === 'enqueued') {
    return 'merge-queue'
  }
  if (review.freshness === 'cached' && areCurrentHeadRequiredChecksGreen(review)) {
    return 'refreshing-merge-gates'
  }
  if (review.draft) {
    return 'draft'
  }
  if (review.providerReadiness.verdict === 'unknown') {
    return 'readiness-unverifiable'
  }
  if (review.providerReadiness.blockers.length > 0) {
    return `waiting:${review.providerReadiness.blockers.join(',')}`
  }
  return null
}

export function deriveHostedReviewSitterStatus(
  review: HostedReviewSnapshot,
  sitter: HostedReviewSitterDefinition,
  ledger: HostedReviewSitterLedger,
  contention: HostedReviewSitterContention
): HostedReviewSitterStatus {
  const activeTimeMs = getActiveTimeMs(ledger)
  const remainingBudgetMs = getRemainingBudgetMs(ledger, sitter.activeBudgetMs)
  const discrepancies = [...deriveHostedReviewSitterDiscrepancies(review, ledger, contention)]
  const base = {
    sitterId: sitter.id,
    enabled: sitter.enabled,
    activeTimeMs,
    remainingBudgetMs,
    discrepancies
  }

  if (!sitter.enabled) {
    return { ...base, state: 'disabled', reason: 'sitter-disabled', desiredAction: null }
  }
  if (review.lifecycle === 'merged') {
    return { ...base, state: 'merged', reason: null, desiredAction: null }
  }
  if (review.lifecycle === 'closed') {
    return { ...base, state: 'closed', reason: 'review-closed', desiredAction: null }
  }
  if (remainingBudgetMs === 0) {
    return { ...base, state: 'budget-exhausted', reason: 'budget-exhausted', desiredAction: null }
  }
  if (
    hasRepeatedFailureAfterOwnFix(review, ledger) ||
    discrepancies.some((entry) => entry.status === 'escalated')
  ) {
    const reason = discrepancies.find((entry) => entry.status === 'escalated')?.reason ?? null
    return { ...base, state: 'escalated', reason, desiredAction: null }
  }
  if (getInFlightActions(ledger).length > 0) {
    return { ...base, state: 'acting', reason: 'action-in-flight', desiredAction: null }
  }

  const desiredAction = computeDesiredAction(review, sitter, ledger)
  if (!desiredAction) {
    return { ...base, state: 'watching', reason: idleReason(review), desiredAction: null }
  }
  const gate = gateDesiredAction(desiredAction, review, sitter, ledger, contention)
  if (gate.verdict === 'hold' && gate.reason === 'awaiting-approval') {
    discrepancies.push(deriveActionApprovalDiscrepancy(desiredAction, ledger))
  }
  if (gate.verdict === 'escalate') {
    return { ...base, state: 'escalated', reason: gate.reason, desiredAction }
  }
  if (gate.verdict === 'hold') {
    return { ...base, state: 'held', reason: gate.reason, desiredAction }
  }
  return { ...base, state: 'acting', reason: null, desiredAction }
}
