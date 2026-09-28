import type { z } from 'zod'
import {
  diffObjectivePlans,
  type ObjectivePlanDiff
} from '../../shared/fork-heimdall-objective/plan-diff'
import type { PlanReviewTargetSchema } from '../../shared/fork-heimdall-objective/objective-actions'
import type { PlanReviewReport } from '../../shared/fork-heimdall-objective/plan-review-schema'
import type { ObjectiveStore } from './objective-store'

export type PlanReviewTarget = z.infer<typeof PlanReviewTargetSchema>

export type PlanReviewDelta = {
  previousReport: PlanReviewReport
  diff: ObjectivePlanDiff
  carryEligible: number[]
}

/**
 * Resolves whether a plan-review dispatch or ingestion qualifies for a delta review: the target is
 * a revision at round 2, its lineage's previous revision has a round-1 review verdict of `revise`,
 * and the diff between the two plans does not itself demand a full review. A patch target, a round
 * other than 2, a missing prior round-1 `revise` review, or a diff over the full-review threshold
 * all resolve to `null` — the caller's normal full review. `round` is the caller's already-decided
 * dispatch round, not recomputed here: it is the single source of truth `decide-plan-review.ts` owns.
 */
export function resolvePlanReviewDelta(
  store: ObjectiveStore,
  watcherId: string,
  target: PlanReviewTarget,
  round: 1 | 2
): PlanReviewDelta | null {
  if (target.kind !== 'revision' || round !== 2) {
    return null
  }
  // revisionNumber isn't carried on the wire target, so resolve the target's immediate
  // predecessor (revisionNumber - 1) from the store's revision list rather than matching any
  // round-1 revise review in the watcher's history.
  const revisions = store.project(watcherId).revisions
  const targetRevision = revisions.find((revision) => revision.id === target.revisionId)
  if (!targetRevision) {
    return null
  }
  const precedingRevision = revisions.find(
    (revision) => revision.number === targetRevision.number - 1
  )
  if (!precedingRevision) {
    return null
  }
  const previousReview = store
    .listPlanReviews(watcherId)
    .find(
      (review) =>
        review.targetKind === 'revision' &&
        review.round === 1 &&
        review.report.verdict === 'revise' &&
        review.targetId === precedingRevision.id
    )
  if (!previousReview) {
    return null
  }
  const previousPlan = store.getPlanReport(previousReview.targetId)
  const currentPlan = store.getPlanReport(target.revisionId)
  if (!previousPlan || !currentPlan) {
    return null
  }
  const diff = diffObjectivePlans(previousPlan.plan, currentPlan.plan)
  if (diff.fullReviewRequired) {
    return null
  }

  const unchanged = new Set(diff.unchanged)
  const previousAssumptions = previousPlan.assumptions ?? []
  const verifiedPreviousClaims = new Set(
    previousReview.report.assumptions
      .filter((assessment) => assessment.status === 'verified')
      .map((assessment) => previousAssumptions[assessment.index]?.claim.trim())
      .filter((claim): claim is string => claim !== undefined)
  )
  const currentAssumptions = currentPlan.assumptions ?? []
  const carryEligible = currentAssumptions.flatMap((assumption, index) =>
    verifiedPreviousClaims.has(assumption.claim.trim()) &&
    assumption.dependentTaskKeys.every((taskKey) => unchanged.has(taskKey))
      ? [index]
      : []
  )

  return { previousReport: previousReview.report, diff, carryEligible }
}
