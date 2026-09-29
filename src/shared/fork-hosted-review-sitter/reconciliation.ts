import { getLatestApproval } from '../fork-heimdall/ledger-queries'
import type { WatcherLedger } from '../fork-heimdall/ledger-types'
import { approvalScopeForHostedReviewAction, makeHostedReviewEvidenceKey } from './action-identity'
import {
  getHostedReviewAttemptDisposition,
  getHostedReviewEscalations,
  getInFlightHostedReviewAttempts,
  getLatestHostedReviewAttempts,
  getUnresolvedHostedReviewAttempts
} from './ledger-adapter'
import { currentHeadChecks, requiresOwnerForCheckRecovery } from './decision-check-groups'
import { getRepeatedFailureAfterOwnFixEvidence } from './stop-policy'
import type {
  DerivedHostedReviewSitterDiscrepancy,
  HostedReviewAttemptEntry,
  HostedReviewCheckSnapshot,
  HostedReviewMergeCheckScope,
  HostedReviewSitterAction,
  HostedReviewSitterContention,
  HostedReviewSitterDiscrepancyKind,
  HostedReviewSitterDiscrepancyStatus,
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
  return makeHostedReviewEvidenceKey([draft.kind, draft.headSha, draft.evidenceKey])
}

function currentStatus(
  draft: DiscrepancyDraft,
  ledger: WatcherLedger
): HostedReviewSitterDiscrepancyStatus {
  const previous = getHostedReviewEscalations(ledger).find(
    (entry) => entry.escalationId === discrepancyId(draft)
  )
  if (!previous || previous.status === 'resolved') {
    return draft.defaultStatus
  }
  return previous.status
}

function toDerived(
  draft: DiscrepancyDraft,
  ledger: WatcherLedger
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
function checkFailureEvidenceKey(
  check: HostedReviewCheckSnapshot,
  ownerRecoveryRequired: boolean
): string {
  const parts = [
    check.checkKey,
    check.failureSignature,
    check.failureSignature ? null : check.observationId
  ]
  if (ownerRecoveryRequired) {
    parts.push('owner-recovery')
  }
  return makeHostedReviewEvidenceKey(parts)
}

function checkFailureDrafts(
  review: HostedReviewSnapshot,
  scope: HostedReviewMergeCheckScope
): readonly DiscrepancyDraft[] {
  const unique = new Map<string, { check: HostedReviewCheckSnapshot; requiresOwner: boolean }>()
  for (const check of currentHeadChecks(review, scope).filter((item) => item.state === 'failed')) {
    const requiresOwner = requiresOwnerForCheckRecovery(review, check, scope)
    const evidenceKey = checkFailureEvidenceKey(check, requiresOwner)
    const previous = unique.get(evidenceKey)
    if (!previous || check.observationId.localeCompare(previous.check.observationId) < 0) {
      unique.set(evidenceKey, { check, requiresOwner })
    }
  }
  return [...unique].map(([evidenceKey, { check, requiresOwner }]) => {
    return {
      kind: 'check-failure',
      evidenceKey,
      headSha: review.headSha,
      defaultStatus: requiresOwner ? 'escalated' : 'open',
      reason: requiresOwner
        ? `check-recovery-requires-owner:${check.checkKey}`
        : check.required
          ? `required-check-failed:${check.checkKey}`
          : `check-failed:${check.checkKey}`
    }
  })
}

function latestCompletedReruns(ledger: WatcherLedger): readonly RerunCheckAction[] {
  return getLatestHostedReviewAttempts(ledger)
    .filter(
      (entry): entry is HostedReviewAttemptEntry & { action: RerunCheckAction } =>
        entry.action.kind === 'rerun-check' &&
        getHostedReviewAttemptDisposition(ledger, entry.action) === 'completed'
    )
    .map((entry) => entry.action)
}

function unverifiableFailureDrafts(
  review: HostedReviewSnapshot,
  ledger: WatcherLedger,
  scope: HostedReviewMergeCheckScope
): readonly DiscrepancyDraft[] {
  const drafts: DiscrepancyDraft[] = []
  for (const rerun of latestCompletedReruns(ledger)) {
    if (rerun.headSha !== review.headSha) {
      continue
    }
    const original = new Set(rerun.observationIds)
    const freshFailures = currentHeadChecks(review, scope).filter(
      (check) =>
        check.state === 'failed' &&
        check.checkKey === rerun.checkKey &&
        !original.has(check.observationId)
    )
    if (freshFailures.length === 0 || freshFailures.some((check) => check.failureSignature)) {
      continue
    }
    const evidenceKey = makeHostedReviewEvidenceKey([
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
  ledger: WatcherLedger,
  scope: HostedReviewMergeCheckScope
): readonly DiscrepancyDraft[] {
  return getRepeatedFailureAfterOwnFixEvidence(review, ledger, scope).map((evidence) => ({
    kind: 'fix-did-not-resolve',
    evidenceKey: makeHostedReviewEvidenceKey([
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

function unresolvedActionDrafts(
  review: HostedReviewSnapshot,
  ledger: WatcherLedger,
  contention?: HostedReviewSitterContention
): readonly DiscrepancyDraft[] {
  const unresolved = [...getUnresolvedHostedReviewAttempts(ledger)]
  if (contention) {
    for (const entry of getInFlightHostedReviewAttempts(ledger)) {
      const isKnownLiveFix =
        contention.state === 'sitter-fix-agent' &&
        contention.actionId === entry.attemptId &&
        entry.action.headSha === review.headSha
      if (!isKnownLiveFix) {
        unresolved.push(entry)
      }
    }
  }

  return unresolved.map((entry) => ({
    kind: 'unresolved-action',
    evidenceKey: makeHostedReviewEvidenceKey([entry.fingerprint, entry.attemptId]),
    headSha: entry.action.headSha,
    defaultStatus: 'escalated',
    reason: `action-outcome-indeterminate:${entry.action.kind}`
  }))
}

function activeDrafts(
  review: HostedReviewSnapshot,
  ledger: WatcherLedger,
  contention: HostedReviewSitterContention | undefined,
  scope: HostedReviewMergeCheckScope
): readonly DiscrepancyDraft[] {
  const drafts: DiscrepancyDraft[] = [
    ...repeatedFixDrafts(review, ledger, scope),
    ...unresolvedActionDrafts(review, ledger, contention),
    ...unverifiableFailureDrafts(review, ledger, scope),
    ...checkFailureDrafts(review, scope)
  ]
  if (review.conflicts === 'present') {
    drafts.push({
      kind: 'merge-conflict',
      evidenceKey: makeHostedReviewEvidenceKey([review.headSha, review.baseSha]),
      headSha: review.headSha,
      defaultStatus: 'open',
      reason: 'merge-conflicts-detected'
    })
  }
  if (review.queue.required && review.queue.membership === 'ejected') {
    drafts.push({
      kind: 'queue-ejected',
      evidenceKey: makeHostedReviewEvidenceKey([review.headSha]),
      headSha: review.headSha,
      defaultStatus: 'escalated',
      reason: 'merge-queue-ejected'
    })
  }
  return drafts
}

function parseDiscrepancyId(
  value: string
): Pick<DerivedHostedReviewSitterDiscrepancy, 'kind' | 'headSha' | 'evidenceKey'> | null {
  try {
    const parsed: unknown = JSON.parse(value)
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 3 ||
      typeof parsed[0] !== 'string' ||
      typeof parsed[1] !== 'string' ||
      typeof parsed[2] !== 'string'
    ) {
      return null
    }
    return {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the escalation id is untyped persisted ledger data; only its shape (3 strings) is checked so a forward-compatible discrepancy kind from a newer build still round-trips.
      kind: parsed[0] as HostedReviewSitterDiscrepancyKind,
      headSha: parsed[1],
      evidenceKey: parsed[2]
    }
  } catch {
    return null
  }
}

export function deriveHostedReviewSitterDiscrepancies(
  review: HostedReviewSnapshot,
  ledger: WatcherLedger,
  scope: HostedReviewMergeCheckScope,
  contention?: HostedReviewSitterContention
): readonly DerivedHostedReviewSitterDiscrepancy[] {
  const active = activeDrafts(review, ledger, contention, scope)
  const activeIds = new Set(active.map(discrepancyId))
  const derived = active.map((draft) => toDerived(draft, ledger))

  for (const previous of getHostedReviewEscalations(ledger)) {
    if (
      previous.status === 'resolved' ||
      previous.escalationKind === 'awaiting-approval' ||
      activeIds.has(previous.escalationId)
    ) {
      continue
    }
    const identity = parseDiscrepancyId(previous.escalationId)
    if (!identity) {
      continue
    }
    derived.push({
      id: previous.escalationId,
      ...identity,
      status: 'resolved',
      reason: 'evidence-no-longer-present'
    })
  }

  return derived.sort((left, right) => left.id.localeCompare(right.id))
}

export function deriveActionApprovalDiscrepancy(
  action: HostedReviewSitterAction,
  ledger: WatcherLedger
): DerivedHostedReviewSitterDiscrepancy {
  const scope = approvalScopeForHostedReviewAction(action)
  const evidenceKey = makeHostedReviewEvidenceKey([
    scope.actionKind,
    scope.contentIdentity,
    scope.evidenceKey,
    scope.preparedCommitSha ?? null
  ])
  const id = makeHostedReviewEvidenceKey(['awaiting-approval', action.headSha, evidenceKey])
  const approval = getLatestApproval(ledger, scope)
  const previous = getHostedReviewEscalations(ledger).find((entry) => entry.escalationId === id)
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
