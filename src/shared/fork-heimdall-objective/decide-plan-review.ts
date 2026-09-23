import type { WatcherLedger } from '../fork-heimdall/ledger-types'
import type { Snapshot } from '../fork-heimdall/snapshot'
import {
  activeObjectiveRevision,
  decidePlannerAction,
  latestObjectiveAttempt,
  objectiveAttemptDisposition,
  objectiveNoAction,
  type ObjectiveAttempt,
  type ObjectiveDecisionOutcome
} from './decision-context'
import { objectiveRepairEpisodeAttempts } from './objective-repair-state'
import type { ActivatePlanAction, ApplyPlanPatchAction, ObjectiveAction } from './objective-actions'
import type {
  ObjectivePendingReport,
  ObjectivePlanPatchProjection,
  ObjectivePlanReviewProjection,
  ObjectiveRevisionProjection,
  ObjectiveWorld
} from './detail-types'

type PlanReviewDispatchAction = Extract<ObjectiveAction, { kind: 'dispatch-plan-review' }>
type PlanReviewTarget = PlanReviewDispatchAction['target']
type PlannerDispatchAction = Extract<ObjectiveAction, { kind: 'dispatch-planner' }>

export type ObjectivePlanReviewGateTarget =
  | { kind: 'revision'; revision: ObjectiveRevisionProjection }
  | { kind: 'patch'; patch: ObjectivePlanPatchProjection; revision: ObjectiveRevisionProjection }

/** The `shape` the target's creating planner dispatch carried, or `undefined` for a pre-upgrade one with none. */
function objectivePlannerDispatchShape(
  attempts: readonly ObjectiveAttempt[],
  dispatchId: string | null
): PlannerDispatchAction['shape'] {
  if (dispatchId === null) {
    return undefined
  }
  for (const { attempt, action } of attempts) {
    if (attempt.dispatchId === dispatchId && action.kind === 'dispatch-planner') {
      return action.shape
    }
  }
  return undefined
}

function objectivePlanReviewApplies(
  world: ObjectiveWorld,
  attempts: readonly ObjectiveAttempt[],
  target: ObjectivePlanReviewGateTarget
): boolean {
  if (world.capabilities?.review === 'off') {
    return false
  }
  if (target.kind === 'patch') {
    return true
  }
  return objectivePlannerDispatchShape(attempts, target.revision.createdByDispatchId) !== undefined
}

/**
 * A draft's review round counts `revise` verdicts on earlier drafts of the same lineage: the ones
 * rejected since the last approval (or since enrollment, when nothing has ever been approved).
 */
function objectiveDraftReviewRound(
  world: ObjectiveWorld,
  draft: ObjectiveRevisionProjection
): 1 | 2 {
  const sinceMs = activeObjectiveRevision(world)?.approvedAtMs ?? 0
  const priorRejectedIds = new Set(
    world.plan.revisions
      .filter(
        (candidate) =>
          candidate.status === 'rejected' &&
          candidate.createdAtMs > sinceMs &&
          candidate.number < draft.number
      )
      .map((candidate) => candidate.id)
  )
  const reviseCount = (world.plan.planReviews ?? []).filter(
    (review) =>
      review.targetKind === 'revision' &&
      review.verdict === 'revise' &&
      priorRejectedIds.has(review.targetId)
  ).length
  return Math.min(2, 1 + reviseCount) as 1 | 2
}

/**
 * A patch's review round counts `revise`-rejected patches earlier in the same repair episode,
 * excluding the patch itself — it may already show as `rejected` by the time this runs (round-1
 * `revise` rejects atomically with recording the verdict), and must not count toward its own round.
 */
function objectivePatchReviewRound(
  world: ObjectiveWorld,
  attempts: readonly ObjectiveAttempt[],
  patch: ObjectivePlanPatchProjection
): 1 | 2 {
  const { sinceOrdinal } = objectiveRepairEpisodeAttempts(world, attempts, patch.revisionId)
  const priorRejectedCount = (world.plan.patches ?? []).filter(
    (candidate) =>
      candidate.revisionId === patch.revisionId &&
      candidate.repairOrdinal > sinceOrdinal &&
      candidate.repairOrdinal < patch.repairOrdinal &&
      candidate.status === 'rejected'
  ).length
  return Math.min(2, 1 + priorRejectedCount) as 1 | 2
}

function objectivePlanReviewWireTarget(target: ObjectivePlanReviewGateTarget): PlanReviewTarget {
  return target.kind === 'revision'
    ? { kind: 'revision', revisionId: target.revision.id }
    : { kind: 'patch', patchId: target.patch.id }
}

type PlanReviewDispatchLookup =
  | { status: 'no-attempt' }
  | { status: 'not-landed' }
  | { status: 'outcome'; outcome: ObjectiveDecisionOutcome }

/**
 * Resolves a single `dispatch-plan-review` evidence key to its current standing: no attempt yet
 * (caller should dispatch), settled `not-landed` (caller decides whether to retry or escalate), or
 * an outcome to return as-is (still in flight, awaiting ingestion, or awaiting a projection refresh).
 */
function objectivePlanReviewDispatchLookup(
  snapshot: Snapshot<ObjectiveWorld>,
  ledger: WatcherLedger,
  attempts: readonly ObjectiveAttempt[],
  reports: readonly ObjectivePendingReport[],
  wireTarget: PlanReviewTarget,
  evidenceKey: string
): PlanReviewDispatchLookup {
  const dispatch = latestObjectiveAttempt(
    attempts,
    (candidate) =>
      candidate.kind === 'dispatch-plan-review' && candidate.evidenceKey === evidenceKey
  )
  if (!dispatch) {
    return { status: 'no-attempt' }
  }
  const disposition = objectiveAttemptDisposition(dispatch.attempt, ledger)
  if (disposition === 'not-landed') {
    return { status: 'not-landed' }
  }
  if (disposition !== 'landed') {
    // in-flight or indeterminate: nothing new to do at this evidence key yet.
    return {
      status: 'outcome',
      outcome: objectiveNoAction('plan', 'plan-review-in-flight', evidenceKey)
    }
  }
  const report = reports.find((candidate) => candidate.dispatchId === dispatch.attempt.dispatchId)
  if (
    report?.outcome !== 'succeeded' ||
    report.reportPath === null ||
    report.evidenceIssue !== undefined ||
    report.reportValidation !== undefined
  ) {
    // a landed disposition is only ever recorded once the report validated cleanly, so this is
    // unreachable in practice; treated as still-settling rather than redispatched, since the
    // evidence key can't change to name a fresh attempt at the same (target, round).
    return {
      status: 'outcome',
      outcome: objectiveNoAction('plan', 'plan-review-in-flight', evidenceKey)
    }
  }
  const ingestion = latestObjectiveAttempt(
    attempts,
    (candidate) =>
      candidate.kind === 'ingest-plan-review' && candidate.dispatchId === report.dispatchId
  )
  if (!ingestion) {
    return {
      status: 'outcome',
      outcome: {
        action: {
          kind: 'ingest-plan-review',
          capability: 'review',
          visibility: 'local',
          recovery: 'replay-safe',
          contentIdentity: snapshot.contentIdentity,
          evidenceKey: report.dispatchId,
          dispatchId: report.dispatchId,
          reportPath: report.reportPath,
          target: wireTarget
        }
      }
    }
  }
  const ingestionDisposition = objectiveAttemptDisposition(ingestion.attempt, ledger)
  if (ingestionDisposition === 'in-flight' || ingestionDisposition === 'indeterminate') {
    return {
      status: 'outcome',
      outcome: objectiveNoAction('plan', 'plan-review-in-flight', report.dispatchId)
    }
  }
  return {
    status: 'outcome',
    outcome: objectiveNoAction('plan', 'projection-refresh-pending', report.dispatchId)
  }
}

/**
 * Wraps a ready-to-emit `activate-plan` or `apply-plan-patch` action with the plan-review gate: off
 * or a pre-upgrade draft passes it through unchanged; otherwise a review is dispatched, ingested, and
 * its verdict resolved before the wrapped action ever lands. A round-1 `revise` rejects the target
 * (already done by ingestion) and redispatches the planner instead of emitting the wrapped action;
 * `escalate` or a round-2 `revise` emits it with `approvalRequired` for a human or owner to decide.
 * A `not-landed` dispatch is retried once at a distinct evidence key for the same (target, round);
 * if the retry also settles `not-landed`, that is treated the same as an `escalate` verdict.
 */
export function decideObjectivePlanReviewGate(
  snapshot: Snapshot<ObjectiveWorld>,
  ledger: WatcherLedger,
  attempts: readonly ObjectiveAttempt[],
  reports: readonly ObjectivePendingReport[],
  target: ObjectivePlanReviewGateTarget,
  action: ActivatePlanAction | ApplyPlanPatchAction
): ObjectiveDecisionOutcome {
  const world = snapshot.world
  if (!objectivePlanReviewApplies(world, attempts, target)) {
    return { action }
  }
  const targetId = target.kind === 'revision' ? target.revision.id : target.patch.id
  const round =
    target.kind === 'revision'
      ? objectiveDraftReviewRound(world, target.revision)
      : objectivePatchReviewRound(world, attempts, target.patch)
  const wireTarget = objectivePlanReviewWireTarget(target)

  const review: ObjectivePlanReviewProjection | undefined = (world.plan.planReviews ?? []).find(
    (candidate) =>
      candidate.targetKind === target.kind &&
      candidate.targetId === targetId &&
      candidate.round === round
  )
  if (review) {
    if (review.verdict === 'approve') {
      return { action }
    }
    if (review.verdict === 'revise' && round === 1) {
      return decidePlannerAction(
        snapshot,
        ledger,
        attempts,
        reports,
        'replan-after-block',
        target.revision.number
      )
    }
    return { action: { ...action, approvalRequired: true } }
  }

  const primaryEvidenceKey = `plan-review:${target.kind}:${targetId}:${round}`
  const primaryLookup = objectivePlanReviewDispatchLookup(
    snapshot,
    ledger,
    attempts,
    reports,
    wireTarget,
    primaryEvidenceKey
  )
  if (primaryLookup.status === 'outcome') {
    return primaryLookup.outcome
  }
  if (primaryLookup.status === 'no-attempt') {
    return {
      action: {
        kind: 'dispatch-plan-review',
        capability: 'review',
        visibility: 'local',
        contentIdentity: snapshot.contentIdentity,
        evidenceKey: primaryEvidenceKey,
        target: wireTarget,
        round
      }
    }
  }

  const retryEvidenceKey = `${primaryEvidenceKey}:retry-1`
  const retryLookup = objectivePlanReviewDispatchLookup(
    snapshot,
    ledger,
    attempts,
    reports,
    wireTarget,
    retryEvidenceKey
  )
  if (retryLookup.status === 'outcome') {
    return retryLookup.outcome
  }
  if (retryLookup.status === 'no-attempt') {
    return {
      action: {
        kind: 'dispatch-plan-review',
        capability: 'review',
        visibility: 'local',
        contentIdentity: snapshot.contentIdentity,
        evidenceKey: retryEvidenceKey,
        target: wireTarget,
        round
      }
    }
  }
  // the retry also settled not-landed: stop retrying, the same outcome as an `escalate` verdict.
  return { action: { ...action, approvalRequired: true } }
}

/**
 * The most recent plan review in T's lineage: the whole pre-approval draft history for a full
 * redispatch, or this repair episode's patches for a repair redispatch. `null` when none exists yet.
 */
export function latestObjectivePlanReviewForPlannerDispatch(
  world: ObjectiveWorld,
  attempts: readonly ObjectiveAttempt[],
  action: PlannerDispatchAction
): ObjectivePlanReviewProjection | null {
  const reviews = world.plan.planReviews ?? []
  const repairRevisionId = action.shape === 'repair' ? action.repairRevisionId : undefined
  const candidates =
    repairRevisionId !== undefined
      ? (() => {
          const { sinceOrdinal } = objectiveRepairEpisodeAttempts(world, attempts, repairRevisionId)
          const patchIds = new Set(
            (world.plan.patches ?? [])
              .filter(
                (patch) =>
                  patch.revisionId === repairRevisionId && patch.repairOrdinal > sinceOrdinal
              )
              .map((patch) => patch.id)
          )
          return reviews.filter(
            (review) => review.targetKind === 'patch' && patchIds.has(review.targetId)
          )
        })()
      : reviews.filter((review) => review.targetKind === 'revision')
  return candidates.sort((left, right) => right.createdAtMs - left.createdAtMs)[0] ?? null
}
