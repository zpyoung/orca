import {
  hostedReviewAttemptFingerprint,
  hostedReviewContentIdentity,
  makeHostedReviewEvidenceKey
} from './action-identity'
import { currentRequiredChecks, type FailedCheckGroup } from './decision-check-groups'
import type {
  HostedReviewAttemptEntry,
  HostedReviewCheckSnapshot,
  HostedReviewSitterAction,
  HostedReviewSitterDefinition,
  HostedReviewPreparedCommit,
  HostedReviewSnapshot,
  PrepareConflictResolutionAction,
  PrepareFixAction,
  PublishConflictResolutionAction,
  PublishFixAction,
  RerunCheckAction
} from './types'

export function buildRerunAction(
  review: HostedReviewSnapshot,
  group: FailedCheckGroup
): RerunCheckAction {
  const checkIds = group.checks.map((check) => check.checkId).sort()
  const observationIds = group.checks.map((check) => check.observationId).sort()
  const signatures = group.checks
    .map((check) => check.failureSignature)
    .filter((signature): signature is string => signature !== null)
    .sort()
  const failureSignature = signatures[0] ?? null
  const evidenceKey = makeHostedReviewEvidenceKey([
    'rerun-check',
    review.headSha,
    group.checkKey,
    failureSignature,
    ...observationIds
  ])
  return {
    kind: 'rerun-check',
    capability: 'fixChecks',
    visibility: 'external',
    contentIdentity: hostedReviewContentIdentity(review),
    evidenceKey,
    expectedState: { target: `${review.url}#check:${group.checkKey}`, before: review.headSha },
    headSha: review.headSha,
    reviewUrl: review.url,
    checkKey: group.checkKey,
    checkIds,
    observationIds,
    failureSignature
  }
}

/** Null when no candidate check carries a failure signature to attribute the fix to. */
export function buildPrepareFixAction(
  review: HostedReviewSnapshot,
  checkKey: string,
  checks: readonly HostedReviewCheckSnapshot[],
  evidence: PrepareFixAction['evidence']
): PrepareFixAction | null {
  const failure = checks
    .filter((check) => check.failureSignature !== null)
    .sort((left, right) => {
      const signatureOrder = left.failureSignature!.localeCompare(right.failureSignature!)
      return signatureOrder || left.observationId.localeCompare(right.observationId)
    })[0]
  if (!failure?.failureSignature) {
    return null
  }

  const matchingChecks = checks.filter(
    (check) => check.failureSignature === failure.failureSignature
  )
  const checkIds = matchingChecks.map((check) => check.checkId).sort()
  const observationIds = matchingChecks.map((check) => check.observationId).sort()
  const evidenceKey = makeHostedReviewEvidenceKey([
    'prepare-fix',
    review.headSha,
    checkKey,
    failure.failureSignature,
    evidence,
    ...observationIds
  ])
  return {
    kind: 'prepare-fix',
    capability: 'fixChecks',
    visibility: 'local',
    contentIdentity: hostedReviewContentIdentity(review),
    evidenceKey,
    headSha: review.headSha,
    reviewUrl: review.url,
    checkKey,
    checkIds,
    observationIds,
    failureSignature: failure.failureSignature,
    evidence
  }
}

/** Null when the completed preparation produced no commit to publish. */
export function buildPublishFixAction(
  preparation: PrepareFixAction,
  completed: HostedReviewAttemptEntry,
  preparedCommit: HostedReviewPreparedCommit | null
): PublishFixAction | null {
  if (
    !preparedCommit ||
    preparedCommit.sourceHeadSha !== preparation.headSha ||
    preparedCommit.preparationAttemptFingerprint !== hostedReviewAttemptFingerprint(preparation)
  ) {
    return null
  }
  const preparedCommitSha = preparedCommit.preparedCommitSha
  const evidenceKey = makeHostedReviewEvidenceKey([
    'publish-fix',
    preparation.headSha,
    preparation.checkKey,
    preparation.failureSignature,
    completed.attemptId,
    preparedCommitSha,
    preparation.evidenceKey
  ])
  return {
    kind: 'publish-fix',
    capability: 'fixChecks',
    visibility: 'external',
    contentIdentity: preparation.contentIdentity,
    evidenceKey,
    expectedState: { target: preparation.reviewUrl, before: preparation.headSha },
    headSha: preparation.headSha,
    reviewUrl: preparation.reviewUrl,
    checkKey: preparation.checkKey,
    failureSignature: preparation.failureSignature,
    preparationActionId: completed.attemptId,
    preparedCommitSha
  }
}

export function buildPrepareConflictAction(
  review: HostedReviewSnapshot
): PrepareConflictResolutionAction {
  const evidenceKey = makeHostedReviewEvidenceKey([
    'prepare-conflict-resolution',
    review.headSha,
    review.baseSha
  ])
  return {
    kind: 'prepare-conflict-resolution',
    capability: 'resolveConflicts',
    visibility: 'local',
    contentIdentity: hostedReviewContentIdentity(review),
    evidenceKey,
    headSha: review.headSha,
    reviewUrl: review.url,
    baseSha: review.baseSha
  }
}

/** Null when the completed preparation produced no commit to publish. */
export function buildPublishConflictAction(
  preparation: PrepareConflictResolutionAction,
  completed: HostedReviewAttemptEntry,
  preparedCommit: HostedReviewPreparedCommit | null
): PublishConflictResolutionAction | null {
  if (
    !preparedCommit ||
    preparedCommit.sourceHeadSha !== preparation.headSha ||
    preparedCommit.preparationAttemptFingerprint !== hostedReviewAttemptFingerprint(preparation)
  ) {
    return null
  }
  const preparedCommitSha = preparedCommit.preparedCommitSha
  const evidenceKey = makeHostedReviewEvidenceKey([
    'publish-conflict-resolution',
    preparation.headSha,
    preparation.baseSha,
    completed.attemptId,
    preparedCommitSha
  ])
  return {
    kind: 'publish-conflict-resolution',
    capability: 'resolveConflicts',
    visibility: 'external',
    contentIdentity: preparation.contentIdentity,
    evidenceKey,
    expectedState: { target: preparation.reviewUrl, before: preparation.headSha },
    headSha: preparation.headSha,
    reviewUrl: preparation.reviewUrl,
    baseSha: preparation.baseSha,
    preparationActionId: completed.attemptId,
    preparedCommitSha
  }
}

export function buildUpdateAction(
  review: HostedReviewSnapshot,
  sitter: HostedReviewSitterDefinition
): HostedReviewSitterAction {
  const evidenceKey = makeHostedReviewEvidenceKey([
    'update-branch',
    review.headSha,
    review.baseSha,
    sitter.branchUpdateMode
  ])
  return {
    kind: 'update-branch',
    capability: 'updateBranch',
    visibility: 'external',
    contentIdentity: hostedReviewContentIdentity(review),
    evidenceKey,
    expectedState: { target: `refs/heads/${sitter.branch}`, before: review.headSha },
    headSha: review.headSha,
    reviewUrl: review.url,
    baseSha: review.baseSha,
    mode: sitter.branchUpdateMode
  }
}

/** Enqueue when the provider requires a merge queue, merge otherwise; null once already enqueued. */
export function buildMergeAction(
  review: HostedReviewSnapshot,
  sitter: HostedReviewSitterDefinition
): HostedReviewSitterAction | null {
  const currentEvidence = currentRequiredChecks(review)
    .map((check) => `${check.checkKey}=${check.state}`)
    .sort()
  if (review.queue.required) {
    if (review.queue.membership !== 'not-enqueued') {
      return null
    }
    const evidenceKey = makeHostedReviewEvidenceKey(['enqueue', review.headSha, ...currentEvidence])
    return {
      kind: 'enqueue',
      capability: 'merge',
      visibility: 'external',
      contentIdentity: hostedReviewContentIdentity(review),
      evidenceKey,
      expectedState: { target: review.url, before: review.headSha },
      headSha: review.headSha,
      reviewUrl: review.url
    }
  }

  const mergeMethod = sitter.mergeMethod ?? review.defaultMergeMethod
  const evidenceKey = makeHostedReviewEvidenceKey([
    'merge',
    review.headSha,
    mergeMethod,
    ...currentEvidence
  ])
  return {
    kind: 'merge',
    capability: 'merge',
    visibility: 'external',
    contentIdentity: hostedReviewContentIdentity(review),
    evidenceKey,
    expectedState: { target: review.url, before: review.headSha },
    headSha: review.headSha,
    reviewUrl: review.url,
    mergeMethod
  }
}
