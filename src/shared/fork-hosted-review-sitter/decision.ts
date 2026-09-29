import type { DecisionOutcome } from '../fork-heimdall/kind-contract'
import type { WatcherLedger } from '../fork-heimdall/ledger-types'
import type { Deviation } from '../fork-heimdall/owner/deviation'
import type { Freshness } from '../fork-heimdall/snapshot'
import {
  getCompletedHostedReviewAttempt,
  getHostedReviewAttemptDisposition,
  getHostedReviewAttemptDispatchId,
  getLatestHostedReviewAttempts,
  hasInFlightHostedReviewAttemptMatching
} from './ledger-adapter'
import {
  buildMergeAction,
  buildPrepareConflictAction,
  buildPrepareFixAction,
  buildPublishConflictAction,
  buildPublishFixAction,
  buildRerunAction,
  buildUpdateAction
} from './decision-action-builders'
import {
  areCurrentHeadChecksGreen,
  deterministicFailureChecks,
  failedCheckGroups,
  freshFailedChecksAfterRerun,
  requiresOwnerForCheckRecovery,
  type FailedCheckGroup
} from './decision-check-groups'
import type {
  HostedReviewAttemptEntry,
  HostedReviewMergeCheckScope,
  HostedReviewPreparedCommit,
  HostedReviewReadinessBlocker,
  HostedReviewSitterAction,
  HostedReviewSitterActionKind,
  HostedReviewSitterDefinition,
  HostedReviewSnapshot,
  HostedReviewWorldSnapshot,
  PrepareFixAction
} from './types'

const UPDATE_READY_BLOCKERS: readonly HostedReviewReadinessBlocker[] = ['behind']

function deviated(deviation: Deviation): { action: null; deviation: Deviation } {
  return { action: null, deviation }
}

/** A step the sitter dispatched or published to never settled cleanly; the owner decides what next. */
function landingFailedDeviation(
  rung: HostedReviewSitterActionKind,
  reason: string,
  contentIdentity: string
): Deviation {
  return { kind: 'landing-failed', rung, reason, contentIdentity }
}

/** A worker the sitter dispatched to prepare a fix never produced a trustworthy outcome. */
function workerUnverifiableDeviation(dispatchId: string | null, reason: string): Deviation {
  return { kind: 'worker-unverifiable', dispatchId, reason }
}

export type HostedReviewSitterNoActionReason =
  | 'review-not-open'
  | 'capability-off'
  | 'conflict-resolution-deferred'
  | 'conflict-resolution-already-attempted'
  | 'conflict-resolution-already-published'
  | 'conflict-preparation-unusable'
  | 'rerun-in-flight'
  | 'rerun-unresolved'
  | 'awaiting-rerun-result'
  | 'failure-signature-unavailable'
  | 'check-rerun-unavailable'
  | 'fix-already-attempted'
  | 'fix-already-published'
  | 'fix-preparation-unusable'
  | 'update-not-ready'
  | 'update-already-attempted'
  | 'merge-gates-unsatisfied'
  | 'queue-already-enqueued'
  | 'merge-already-attempted'
  | 'owner-retry-in-flight'

export type HostedReviewSitterDecisionPhase = 'conflicts' | 'fix-checks' | 'update-branch'

/** A phase that declined before control fell through to the terminal reason. */
export type HostedReviewSitterConsideredPhase = {
  phase: HostedReviewSitterDecisionPhase
  reason: HostedReviewSitterNoActionReason
  detail?: string
}

type PhaseOutcome =
  | { action: HostedReviewSitterAction }
  | { action: null; reason: HostedReviewSitterNoActionReason; detail?: string }
  | { action: null; deviation: Deviation }

export type HostedReviewSitterDecisionOutcome = DecisionOutcome<HostedReviewSitterAction>

export type HostedReviewDecisionContext = {
  freshness: Freshness
  preparedCommit: HostedReviewPreparedCommit | null
}

function declined(
  reason: HostedReviewSitterNoActionReason,
  detail?: string
): { action: null; reason: HostedReviewSitterNoActionReason; detail?: string } {
  return detail === undefined ? { action: null, reason } : { action: null, reason, detail }
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
  ledger: WatcherLedger,
  headSha: string,
  checkKey: string
): HostedReviewAttemptEntry | null {
  let latest: HostedReviewAttemptEntry | null = null
  for (const entry of getLatestHostedReviewAttempts(ledger)) {
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

function desiredFixAction(
  review: HostedReviewSnapshot,
  ledger: WatcherLedger,
  group: FailedCheckGroup,
  scope: HostedReviewMergeCheckScope,
  preparedCommit: HostedReviewPreparedCommit | null
): PhaseOutcome {
  if (group.checks.some((check) => requiresOwnerForCheckRecovery(review, check, scope))) {
    return declined('check-rerun-unavailable', group.checkKey)
  }
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
      return { action: buildRerunAction(review, group) }
    }
    const rerunDisposition = getHostedReviewAttemptDisposition(ledger, rerunEntry.action)
    if (rerunDisposition === 'in-flight') {
      return declined('rerun-in-flight')
    }
    if (rerunDisposition === 'retryable-failure') {
      return { action: buildRerunAction(review, group) }
    }
    if (rerunDisposition === 'unresolved') {
      if (
        hasInFlightHostedReviewAttemptMatching(
          ledger,
          (action) =>
            action.kind === 'rerun-check' &&
            action.headSha === review.headSha &&
            action.checkKey === group.checkKey
        )
      ) {
        return declined('owner-retry-in-flight')
      }
      return deviated(
        landingFailedDeviation('rerun-check', 'rerun disposition never settled', review.headSha)
      )
    }
    if (rerunEntry.action.kind !== 'rerun-check') {
      return declined('rerun-unresolved')
    }
    const freshFailures = freshFailedChecksAfterRerun(review, group, rerunEntry.action, scope)
    if (!freshFailures) {
      return declined('awaiting-rerun-result')
    }
    preparation = buildPrepareFixAction(review, group.checkKey, freshFailures, 'fresh-rerun')
  }

  if (!preparation) {
    return declined('failure-signature-unavailable')
  }
  const disposition = getHostedReviewAttemptDisposition(ledger, preparation)
  if (disposition === 'unseen' || disposition === 'retryable-failure') {
    return { action: preparation }
  }
  if (disposition === 'unresolved') {
    if (
      hasInFlightHostedReviewAttemptMatching(
        ledger,
        (action) =>
          action.kind === 'prepare-fix' &&
          action.headSha === review.headSha &&
          action.checkKey === group.checkKey
      )
    ) {
      return declined('owner-retry-in-flight')
    }
    return deviated(
      workerUnverifiableDeviation(
        getHostedReviewAttemptDispatchId(ledger, preparation),
        'prepare-fix dispatch never produced a verifiable outcome'
      )
    )
  }
  if (disposition !== 'completed') {
    return declined('fix-already-attempted', disposition)
  }

  const completed = getCompletedHostedReviewAttempt(ledger, preparation)
  if (!completed) {
    return declined('fix-already-attempted', disposition)
  }
  const publication = buildPublishFixAction(preparation, completed, preparedCommit)
  if (!publication) {
    return deviated(
      workerUnverifiableDeviation(
        completed.dispatchId ?? null,
        'completed prepare-fix produced no usable prepared commit'
      )
    )
  }
  const publicationDisposition = getHostedReviewAttemptDisposition(ledger, publication)
  if (publicationDisposition === 'unseen' || publicationDisposition === 'retryable-failure') {
    return { action: publication }
  }
  if (publicationDisposition === 'unresolved') {
    return deviated(
      landingFailedDeviation('publish-fix', 'publish disposition never settled', review.headSha)
    )
  }
  return declined('fix-already-published', publicationDisposition)
}

function desiredConflictAction(
  review: HostedReviewSnapshot,
  ledger: WatcherLedger,
  preparedCommit: HostedReviewPreparedCommit | null
): PhaseOutcome {
  const preparation = buildPrepareConflictAction(review)
  const disposition = getHostedReviewAttemptDisposition(ledger, preparation)
  if (disposition === 'unseen' || disposition === 'retryable-failure') {
    return { action: preparation }
  }
  if (disposition === 'unresolved') {
    if (
      hasInFlightHostedReviewAttemptMatching(
        ledger,
        (action) =>
          action.kind === 'prepare-conflict-resolution' && action.headSha === review.headSha
      )
    ) {
      return declined('owner-retry-in-flight')
    }
    return deviated(
      workerUnverifiableDeviation(
        getHostedReviewAttemptDispatchId(ledger, preparation),
        'prepare-conflict-resolution dispatch never produced a verifiable outcome'
      )
    )
  }
  if (disposition !== 'completed') {
    return declined('conflict-resolution-already-attempted', disposition)
  }

  const completed = getCompletedHostedReviewAttempt(ledger, preparation)
  if (!completed) {
    return declined('conflict-resolution-already-attempted', disposition)
  }
  const publication = buildPublishConflictAction(preparation, completed, preparedCommit)
  if (!publication) {
    return deviated(
      workerUnverifiableDeviation(
        completed.dispatchId ?? null,
        'completed prepare-conflict-resolution produced no usable prepared commit'
      )
    )
  }
  const publicationDisposition = getHostedReviewAttemptDisposition(ledger, publication)
  if (publicationDisposition === 'unseen' || publicationDisposition === 'retryable-failure') {
    return { action: publication }
  }
  if (publicationDisposition === 'unresolved') {
    return deviated(
      landingFailedDeviation(
        'publish-conflict-resolution',
        'publish disposition never settled',
        review.headSha
      )
    )
  }
  return declined('conflict-resolution-already-published', publicationDisposition)
}

function unsatisfiedMergeGates(
  review: HostedReviewSnapshot,
  sitter: HostedReviewSitterDefinition,
  checksGreen: boolean,
  freshness: Freshness
): readonly string[] {
  const unsatisfied: string[] = []
  if (sitter.capabilities.merge === 'off') {
    unsatisfied.push('capability')
  }
  if (freshness !== 'live') {
    unsatisfied.push('freshness')
  }
  if (review.draft) {
    unsatisfied.push('draft')
  }
  if (review.conflicts !== 'none') {
    unsatisfied.push('conflicts')
  }
  if (!checksGreen) {
    unsatisfied.push('checks')
  }
  if (review.providerReadiness.verdict !== 'ready') {
    unsatisfied.push('readiness')
  }
  if (review.queue.membership !== 'not-enqueued') {
    unsatisfied.push('queue')
  }
  return unsatisfied
}

/** The deterministic hosted-review policy, with every declined phase retained for diagnostics. */
export function explainDesiredAction(
  review: HostedReviewSnapshot,
  sitter: HostedReviewSitterDefinition,
  ledger: WatcherLedger,
  context: HostedReviewDecisionContext
): HostedReviewSitterDecisionOutcome {
  const considered: HostedReviewSitterConsideredPhase[] = []
  const fellThrough = (
    outcome:
      | { action: null; reason: HostedReviewSitterNoActionReason; detail?: string }
      | { action: null; deviation: Deviation }
  ): HostedReviewSitterDecisionOutcome =>
    'deviation' in outcome
      ? { action: null, deviation: outcome.deviation }
      : { ...outcome, considered }

  if (review.lifecycle !== 'open') {
    return fellThrough(declined('review-not-open', review.lifecycle))
  }

  const checksGreen = areCurrentHeadChecksGreen(review, sitter.mergeCheckScope)
  const failures = failedCheckGroups(review, sitter.mergeCheckScope)
  // Conflicts usually stop CI from building a merge commit. A red check still comes first unless
  // the base moved, since the move is what made that check red.
  const conflictOtherwiseReady = !review.draft && (failures.length === 0 || review.behindBase)
  if (review.conflicts === 'present') {
    if (sitter.capabilities.resolveConflicts === 'off') {
      return fellThrough(declined('capability-off', 'resolveConflicts'))
    }
    if (conflictOtherwiseReady) {
      const outcome = desiredConflictAction(review, ledger, context.preparedCommit)
      return outcome.action ? outcome : fellThrough(outcome)
    }
    considered.push({ phase: 'conflicts', reason: 'conflict-resolution-deferred' })
  }

  if (failures.length > 0) {
    if (sitter.capabilities.fixChecks === 'off') {
      considered.push({ phase: 'fix-checks', reason: 'capability-off', detail: 'fixChecks' })
    } else {
      const outcome = desiredFixAction(
        review,
        ledger,
        failures[0]!,
        sitter.mergeCheckScope,
        context.preparedCommit
      )
      if (outcome.action) {
        return outcome
      }
      if ('deviation' in outcome) {
        return fellThrough(outcome)
      }
      considered.push({ phase: 'fix-checks', reason: outcome.reason, detail: outcome.detail })
    }
  }

  if (review.behindBase && review.conflicts === 'none') {
    if (sitter.capabilities.updateBranch === 'off') {
      considered.push({ phase: 'update-branch', reason: 'capability-off', detail: 'updateBranch' })
    } else {
      const otherwiseReady =
        !review.draft && checksGreen && readinessAllowsOnly(review, UPDATE_READY_BLOCKERS)
      const redAfterBaseMove = failures.length > 0 && !review.draft
      if (!otherwiseReady && !redAfterBaseMove) {
        considered.push({ phase: 'update-branch', reason: 'update-not-ready' })
      } else {
        const action = buildUpdateAction(review, sitter)
        const disposition = getHostedReviewAttemptDisposition(ledger, action)
        if (disposition === 'unseen' || disposition === 'retryable-failure') {
          return { action }
        }
        if (
          disposition === 'unresolved' &&
          !hasInFlightHostedReviewAttemptMatching(
            ledger,
            (candidate) =>
              candidate.kind === 'update-branch' && candidate.headSha === review.headSha
          )
        ) {
          return fellThrough(
            deviated(
              landingFailedDeviation(
                'update-branch',
                'update disposition never settled',
                review.headSha
              )
            )
          )
        }
        considered.push({
          phase: 'update-branch',
          reason:
            disposition === 'unresolved' ? 'owner-retry-in-flight' : 'update-already-attempted',
          detail: disposition === 'unresolved' ? undefined : disposition
        })
      }
    }
  }

  const unsatisfied = unsatisfiedMergeGates(review, sitter, checksGreen, context.freshness)
  if (unsatisfied.length > 0) {
    if (review.queue.required && review.queue.membership === 'ejected') {
      return fellThrough(
        deviated(
          landingFailedDeviation('enqueue', 'merge queue ejected the review', review.headSha)
        )
      )
    }
    return fellThrough(declined('merge-gates-unsatisfied', unsatisfied.join(',')))
  }

  const action = buildMergeAction(review, sitter)
  if (!action) {
    return fellThrough(declined('queue-already-enqueued', review.queue.membership))
  }
  const disposition = getHostedReviewAttemptDisposition(ledger, action)
  if (disposition === 'unseen' || disposition === 'retryable-failure') {
    return { action }
  }
  if (disposition === 'unresolved') {
    return fellThrough(
      deviated(
        landingFailedDeviation(
          action.kind,
          `${action.kind} disposition never settled`,
          review.headSha
        )
      )
    )
  }
  return fellThrough(declined('merge-already-attempted', disposition))
}

export function computeDesiredAction(
  review: HostedReviewSnapshot,
  sitter: HostedReviewSitterDefinition,
  ledger: WatcherLedger,
  context: HostedReviewDecisionContext
): HostedReviewSitterAction | null {
  return explainDesiredAction(review, sitter, ledger, context).action
}

export function decideHostedReview(
  snapshot: HostedReviewWorldSnapshot,
  ledger: WatcherLedger
): HostedReviewSitterDecisionOutcome {
  return explainDesiredAction(snapshot.world.review, snapshot.world.definition, ledger, {
    freshness: snapshot.freshness,
    preparedCommit: snapshot.world.preparedCommit
  })
}
