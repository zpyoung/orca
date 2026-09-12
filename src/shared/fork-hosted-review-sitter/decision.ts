import {
  getActionDisposition,
  getActiveTimeMs,
  getCompletedActionForKey,
  getLatestActionTransitions,
  getLatestDiscrepancies,
  makeActionKey,
  makeEvidenceKey
} from './ledger'
import { hasRepeatedFailureAfterOwnFix, hasUnverifiableReproducedFailure } from './stop-policy'
import type {
  ActionLedgerEntry,
  HostedReviewCheckSnapshot,
  HostedReviewReadinessBlocker,
  HostedReviewSitterAction,
  HostedReviewSitterDefinition,
  HostedReviewSitterLedger,
  HostedReviewSnapshot,
  PrepareConflictResolutionAction,
  PrepareFixAction,
  PublishConflictResolutionAction,
  PublishFixAction,
  RerunCheckAction
} from './types'

type FailedCheckGroup = {
  checkKey: string
  checks: readonly HostedReviewCheckSnapshot[]
}

const CONFLICT_READY_BLOCKERS: readonly HostedReviewReadinessBlocker[] = ['behind', 'conflicts']
const UPDATE_READY_BLOCKERS: readonly HostedReviewReadinessBlocker[] = ['behind']

function currentRequiredChecks(review: HostedReviewSnapshot): readonly HostedReviewCheckSnapshot[] {
  return review.checks.filter((check) => check.required && check.headSha === review.headSha)
}

export function areCurrentHeadRequiredChecksGreen(review: HostedReviewSnapshot): boolean {
  if (!review.checksComplete) {
    return false
  }
  for (const check of review.checks) {
    if (check.required && (check.headSha !== review.headSha || check.state !== 'passed')) {
      return false
    }
  }
  return true
}

function failedCheckGroups(review: HostedReviewSnapshot): readonly FailedCheckGroup[] {
  const grouped = new Map<string, HostedReviewCheckSnapshot[]>()
  for (const check of currentRequiredChecks(review)) {
    if (check.state !== 'failed') {
      continue
    }
    const existing = grouped.get(check.checkKey)
    if (existing) {
      existing.push(check)
    } else {
      grouped.set(check.checkKey, [check])
    }
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([checkKey, checks]) => ({
      checkKey,
      checks: checks.sort((left, right) => left.observationId.localeCompare(right.observationId))
    }))
}

function readinessAllowsOnly(
  review: HostedReviewSnapshot,
  allowed: readonly HostedReviewReadinessBlocker[]
): boolean {
  if (review.providerReadiness.verdict === 'ready') {
    return true
  }
  if (review.providerReadiness.verdict !== 'blocked') {
    return false
  }
  if (review.providerReadiness.blockers.length === 0) {
    return false
  }
  return review.providerReadiness.blockers.every((blocker) => allowed.includes(blocker))
}

function latestRerunForCheck(
  ledger: HostedReviewSitterLedger,
  headSha: string,
  checkKey: string
): ActionLedgerEntry | null {
  let latest: ActionLedgerEntry | null = null
  for (const entry of getLatestActionTransitions(ledger)) {
    if (
      entry.action.kind !== 'rerun-check' ||
      entry.action.headSha !== headSha ||
      entry.action.checkKey !== checkKey
    ) {
      continue
    }
    if (!latest || entry.atMs >= latest.atMs) {
      latest = entry
    }
  }
  return latest
}

function buildRerunAction(review: HostedReviewSnapshot, group: FailedCheckGroup): RerunCheckAction {
  const checkIds = group.checks.map((check) => check.checkId).sort()
  const observationIds = group.checks.map((check) => check.observationId).sort()
  const signatures = group.checks
    .map((check) => check.failureSignature)
    .filter((signature): signature is string => signature !== null)
    .sort()
  const failureSignature = signatures[0] ?? null
  const evidenceKey = makeEvidenceKey([
    'rerun-check',
    review.headSha,
    group.checkKey,
    failureSignature,
    ...observationIds
  ])
  return {
    kind: 'rerun-check',
    capability: 'fixChecks',
    key: makeActionKey(review.headSha, 'rerun-check', evidenceKey),
    evidenceKey,
    headSha: review.headSha,
    checkKey: group.checkKey,
    checkIds,
    observationIds,
    failureSignature
  }
}

function deterministicFailureChecks(
  group: FailedCheckGroup
): readonly HostedReviewCheckSnapshot[] | null {
  const candidates = new Map<string, HostedReviewCheckSnapshot[]>()
  for (const check of group.checks) {
    if (!check.failureSignature || !check.shardKey || !check.runtimeKey) {
      continue
    }
    const identity = makeEvidenceKey([check.shardKey, check.failureSignature])
    const existing = candidates.get(identity)
    if (existing) {
      existing.push(check)
    } else {
      candidates.set(identity, [check])
    }
  }

  for (const checks of [...candidates.values()].sort((left, right) => {
    return left[0]!.observationId.localeCompare(right[0]!.observationId)
  })) {
    const runtimes = new Set(checks.map((check) => check.runtimeKey))
    if (runtimes.size >= 2) {
      return checks
    }
  }
  return null
}

function freshFailedChecksAfterRerun(
  review: HostedReviewSnapshot,
  group: FailedCheckGroup,
  rerun: RerunCheckAction
): readonly HostedReviewCheckSnapshot[] | null {
  const current = currentRequiredChecks(review).filter((check) => check.checkKey === group.checkKey)
  if (current.length === 0) {
    return null
  }
  const originalObservations = new Set(rerun.observationIds)
  if (current.some((check) => originalObservations.has(check.observationId))) {
    return null
  }
  const failures = current.filter((check) => check.state === 'failed')
  return failures.length > 0 ? failures : null
}

function buildPrepareFixAction(
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
  const evidenceKey = makeEvidenceKey([
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
    key: makeActionKey(review.headSha, 'prepare-fix', evidenceKey),
    evidenceKey,
    headSha: review.headSha,
    checkKey,
    checkIds,
    observationIds,
    failureSignature: failure.failureSignature,
    evidence
  }
}

function buildPublishFixAction(
  preparation: PrepareFixAction,
  completed: ActionLedgerEntry
): PublishFixAction | null {
  if (completed.result?.kind !== 'prepared') {
    return null
  }
  const preparedCommitSha = completed.result.preparedCommitSha
  const evidenceKey = makeEvidenceKey([
    'publish-fix',
    preparation.headSha,
    preparation.checkKey,
    preparation.failureSignature,
    completed.actionId,
    preparedCommitSha,
    preparation.evidenceKey
  ])
  return {
    kind: 'publish-fix',
    capability: 'fixChecks',
    key: makeActionKey(preparation.headSha, 'publish-fix', evidenceKey),
    evidenceKey,
    headSha: preparation.headSha,
    checkKey: preparation.checkKey,
    failureSignature: preparation.failureSignature,
    preparationActionId: completed.actionId,
    preparedCommitSha
  }
}

function desiredFixAction(
  review: HostedReviewSnapshot,
  ledger: HostedReviewSitterLedger,
  group: FailedCheckGroup
): HostedReviewSitterAction | null {
  const deterministic = deterministicFailureChecks(group)
  let preparation: PrepareFixAction | null = null

  if (deterministic) {
    preparation = buildPrepareFixAction(
      review,
      group.checkKey,
      deterministic,
      'same-shard-multi-node'
    )
  } else {
    const rerunEntry = latestRerunForCheck(ledger, review.headSha, group.checkKey)
    if (!rerunEntry) {
      return buildRerunAction(review, group)
    }
    if (rerunEntry.state === 'attempted' || rerunEntry.state === 'running') {
      return null
    }
    if (rerunEntry.state === 'failed') {
      return rerunEntry.effect === 'none' ? buildRerunAction(review, group) : null
    }
    if (rerunEntry.action.kind !== 'rerun-check') {
      return null
    }
    const freshFailures = freshFailedChecksAfterRerun(review, group, rerunEntry.action)
    if (!freshFailures) {
      return null
    }
    preparation = buildPrepareFixAction(review, group.checkKey, freshFailures, 'fresh-rerun')
  }

  if (!preparation) {
    return null
  }
  const disposition = getActionDisposition(ledger, preparation.key)
  if (disposition === 'unseen' || disposition === 'retryable-failure') {
    return preparation
  }
  if (disposition !== 'completed') {
    return null
  }

  const completed = getCompletedActionForKey(ledger, preparation.key)
  if (!completed) {
    return null
  }
  const publication = buildPublishFixAction(preparation, completed)
  if (!publication) {
    return null
  }
  const publicationDisposition = getActionDisposition(ledger, publication.key)
  if (publicationDisposition === 'unseen' || publicationDisposition === 'retryable-failure') {
    return publication
  }
  return null
}

function buildPrepareConflictAction(review: HostedReviewSnapshot): PrepareConflictResolutionAction {
  const evidenceKey = makeEvidenceKey([
    'prepare-conflict-resolution',
    review.headSha,
    review.baseSha
  ])
  return {
    kind: 'prepare-conflict-resolution',
    capability: 'resolveConflicts',
    key: makeActionKey(review.headSha, 'prepare-conflict-resolution', evidenceKey),
    evidenceKey,
    headSha: review.headSha,
    baseSha: review.baseSha
  }
}

function buildPublishConflictAction(
  preparation: PrepareConflictResolutionAction,
  completed: ActionLedgerEntry
): PublishConflictResolutionAction | null {
  if (completed.result?.kind !== 'prepared') {
    return null
  }
  const preparedCommitSha = completed.result.preparedCommitSha
  const evidenceKey = makeEvidenceKey([
    'publish-conflict-resolution',
    preparation.headSha,
    preparation.baseSha,
    completed.actionId,
    preparedCommitSha
  ])
  return {
    kind: 'publish-conflict-resolution',
    capability: 'resolveConflicts',
    key: makeActionKey(preparation.headSha, 'publish-conflict-resolution', evidenceKey),
    evidenceKey,
    headSha: preparation.headSha,
    baseSha: preparation.baseSha,
    preparationActionId: completed.actionId,
    preparedCommitSha
  }
}

function desiredConflictAction(
  review: HostedReviewSnapshot,
  ledger: HostedReviewSitterLedger
): HostedReviewSitterAction | null {
  const preparation = buildPrepareConflictAction(review)
  const disposition = getActionDisposition(ledger, preparation.key)
  if (disposition === 'unseen' || disposition === 'retryable-failure') {
    return preparation
  }
  if (disposition !== 'completed') {
    return null
  }

  const completed = getCompletedActionForKey(ledger, preparation.key)
  if (!completed) {
    return null
  }
  const publication = buildPublishConflictAction(preparation, completed)
  if (!publication) {
    return null
  }
  const publicationDisposition = getActionDisposition(ledger, publication.key)
  if (publicationDisposition === 'unseen' || publicationDisposition === 'retryable-failure') {
    return publication
  }
  return null
}

function hasCurrentEscalation(
  review: HostedReviewSnapshot,
  ledger: HostedReviewSitterLedger
): boolean {
  return [...getLatestDiscrepancies(ledger).values()].some(
    (entry) => entry.headSha === review.headSha && entry.status === 'escalated'
  )
}

function buildUpdateAction(
  review: HostedReviewSnapshot,
  sitter: HostedReviewSitterDefinition
): HostedReviewSitterAction {
  const evidenceKey = makeEvidenceKey([
    'update-branch',
    review.headSha,
    review.baseSha,
    sitter.branchUpdateMode
  ])
  return {
    kind: 'update-branch',
    capability: 'updateBranch',
    key: makeActionKey(review.headSha, 'update-branch', evidenceKey),
    evidenceKey,
    headSha: review.headSha,
    baseSha: review.baseSha,
    mode: sitter.branchUpdateMode
  }
}

function buildMergeAction(
  review: HostedReviewSnapshot,
  sitter: HostedReviewSitterDefinition
): HostedReviewSitterAction | null {
  const currentEvidence = currentRequiredChecks(review)
    .map((check) => check.observationId)
    .sort()
  if (review.queue.required) {
    if (review.queue.membership !== 'not-enqueued') {
      return null
    }
    const evidenceKey = makeEvidenceKey(['enqueue', review.headSha, ...currentEvidence])
    return {
      kind: 'enqueue',
      capability: 'merge',
      key: makeActionKey(review.headSha, 'enqueue', evidenceKey),
      evidenceKey,
      headSha: review.headSha
    }
  }

  const mergeMethod = sitter.mergeMethod ?? review.defaultMergeMethod
  const evidenceKey = makeEvidenceKey(['merge', review.headSha, mergeMethod, ...currentEvidence])
  return {
    kind: 'merge',
    capability: 'merge',
    key: makeActionKey(review.headSha, 'merge', evidenceKey),
    evidenceKey,
    headSha: review.headSha,
    mergeMethod
  }
}

export function computeDesiredAction(
  review: HostedReviewSnapshot,
  sitter: HostedReviewSitterDefinition,
  ledger: HostedReviewSitterLedger
): HostedReviewSitterAction | null {
  if (!sitter.enabled || review.lifecycle !== 'open') {
    return null
  }
  if (getActiveTimeMs(ledger) >= sitter.activeBudgetMs) {
    return null
  }
  if (
    hasCurrentEscalation(review, ledger) ||
    hasRepeatedFailureAfterOwnFix(review, ledger) ||
    hasUnverifiableReproducedFailure(review, ledger)
  ) {
    return null
  }

  const unresolvedAttempt = getLatestActionTransitions(ledger).some((entry) => {
    if (entry.state === 'attempted' || entry.state === 'running') {
      return true
    }
    return entry.state === 'failed' && entry.effect !== 'none'
  })
  if (unresolvedAttempt) {
    return null
  }

  const checksGreen = areCurrentHeadRequiredChecksGreen(review)
  const failures = failedCheckGroups(review)
  const conflictOtherwiseReady =
    !review.draft &&
    ((checksGreen && readinessAllowsOnly(review, CONFLICT_READY_BLOCKERS)) ||
      (review.behindBase && failures.length > 0))
  if (review.conflicts === 'present' && conflictOtherwiseReady) {
    return desiredConflictAction(review, ledger)
  }

  if (failures.length > 0 && sitter.capabilities.fixChecks !== 'off') {
    const checkAction = desiredFixAction(review, ledger, failures[0]!)
    if (checkAction) {
      return checkAction
    }
  }

  if (
    review.behindBase &&
    review.conflicts === 'none' &&
    sitter.capabilities.updateBranch !== 'off'
  ) {
    const otherwiseReady =
      !review.draft && checksGreen && readinessAllowsOnly(review, UPDATE_READY_BLOCKERS)
    const redAfterBaseMove = failures.length > 0 && !review.draft
    if (otherwiseReady || redAfterBaseMove) {
      const action = buildUpdateAction(review, sitter)
      const disposition = getActionDisposition(ledger, action.key)
      if (disposition === 'unseen' || disposition === 'retryable-failure') {
        return action
      }
    }
  }

  const everyMergeGateSatisfied =
    sitter.capabilities.merge !== 'off' &&
    review.freshness === 'live' &&
    !review.draft &&
    review.conflicts === 'none' &&
    checksGreen &&
    review.providerReadiness.verdict === 'ready' &&
    review.queue.membership === 'not-enqueued'
  if (!everyMergeGateSatisfied) {
    return null
  }

  const action = buildMergeAction(review, sitter)
  if (!action) {
    return null
  }
  const disposition = getActionDisposition(ledger, action.key)
  return disposition === 'unseen' || disposition === 'retryable-failure' ? action : null
}
