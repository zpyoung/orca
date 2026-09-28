import type {
  ObjectiveEnrollmentPayload,
  ObjectiveGate
} from '../../shared/fork-heimdall-objective/contract-types'
import type {
  ObjectiveDetailAssumption,
  ObjectiveDetailGate,
  ObjectiveDetailPendingPatch,
  ObjectiveDetailPlanReview,
  ObjectiveGateAttemptProjection,
  ObjectivePlanPatchProjection,
  ObjectivePlanReviewProjection,
  ObjectiveProjection
} from '../../shared/fork-heimdall-objective/detail-types'
import type { ObjectiveDispatchRecord } from '../../shared/fork-heimdall-objective/parallel-types'
import {
  lintObjectivePlan,
  type ObjectivePlanLint
} from '../../shared/fork-heimdall-objective/plan-lint'
import {
  objectivePathMatchesTerritory,
  type ObjectivePlanAssumption,
  type ObjectivePlanTask
} from '../../shared/fork-heimdall-objective/plan-schema'
import type { ObjectiveDatabase } from './objective-database'
import { getPlanPatch } from './objective-store-plan-patches'
import { getPlanReviewReport } from './objective-store-plan-reviews'
import { ObjectiveStoreQueries } from './objective-store-queries'

const PLAN_REVIEWS_MAX = 16

export type ObjectiveNodeTerritoryDetail = {
  territory?: readonly string[]
  overrunPaths?: readonly string[]
}

export type ObjectiveDetailPlanQuality = {
  nodeDetailByKey: Map<string, ObjectiveNodeTerritoryDetail>
  planLint?: ObjectivePlanLint
  assumptions?: ObjectiveDetailAssumption[]
  planReviews?: ObjectiveDetailPlanReview[]
  pendingPatch?: ObjectiveDetailPendingPatch
  gates?: ObjectiveDetailGate[]
  noGateDeclared?: true
}

/** Latest dispatch record that carries a report for this revision/task, by completion (or start) time. */
function latestReportingDispatch(
  dispatches: readonly ObjectiveDispatchRecord[],
  revisionId: string,
  taskKey: string
): ObjectiveDispatchRecord | undefined {
  let best: ObjectiveDispatchRecord | undefined
  let bestAtMs = -Infinity
  for (const dispatch of dispatches) {
    if (dispatch.revisionId !== revisionId || dispatch.taskKey !== taskKey || !dispatch.report) {
      continue
    }
    const atMs = dispatch.completedAtMs ?? dispatch.createdAtMs
    if (atMs >= bestAtMs) {
      best = dispatch
      bestAtMs = atMs
    }
  }
  return best
}

function buildNodeDetail(
  dispatches: readonly ObjectiveDispatchRecord[],
  revisionId: string,
  task: ObjectivePlanTask
): ObjectiveNodeTerritoryDetail {
  const detail: ObjectiveNodeTerritoryDetail = {}
  if (task.territory !== undefined) {
    detail.territory = task.territory
  }
  const dispatch = latestReportingDispatch(dispatches, revisionId, task.taskKey)
  const dispatchTerritory = dispatch?.task.territory
  if (dispatch?.report && dispatchTerritory !== undefined) {
    detail.overrunPaths = dispatch.report.filesModified.filter(
      (path) => !objectivePathMatchesTerritory(path, dispatchTerritory)
    )
  }
  return detail
}

/**
 * Status/evidence for the plan's assumptions. The revision's own assumptions are assessed by the
 * newest review targeting the revision; each applied patch's appended assumptions are assessed by
 * that patch's own newest review, so the patch-local indices its review scored against have to be
 * remapped onto the merged positions `mergeAssumptionsOntoRevision` appended them at.
 */
function buildAssumptions(
  database: ObjectiveDatabase,
  planAssumptions: readonly ObjectivePlanAssumption[],
  reviews: readonly ObjectivePlanReviewProjection[],
  patches: readonly ObjectivePlanPatchProjection[],
  revisionId: string
): ObjectiveDetailAssumption[] {
  const newestReview = reviews.find(
    (review) => review.targetKind === 'revision' && review.targetId === revisionId
  )
  const fullReport = newestReview ? getPlanReviewReport(database, newestReview.id) : null
  const assessmentByIndex = new Map(
    (fullReport?.assumptions ?? []).map((assessment) => [assessment.index, assessment])
  )

  const appliedPatches = patches
    .filter((patch) => patch.revisionId === revisionId && patch.status === 'applied')
    .slice()
    .sort((left, right) => (left.resolvedAtMs ?? 0) - (right.resolvedAtMs ?? 0))
  const appliedPatchAssumptionCounts = appliedPatches.map(
    (patch) => getPlanPatch(database, patch.id)?.report.assumptions?.length ?? 0
  )
  let mergedOffset =
    planAssumptions.length - appliedPatchAssumptionCounts.reduce((sum, count) => sum + count, 0)
  appliedPatches.forEach((patch, patchIndex) => {
    const newestPatchReview = reviews.find(
      (review) => review.targetKind === 'patch' && review.targetId === patch.id
    )
    const patchReport = newestPatchReview
      ? getPlanReviewReport(database, newestPatchReview.id)
      : null
    for (const assessment of patchReport?.assumptions ?? []) {
      assessmentByIndex.set(mergedOffset + assessment.index, assessment)
    }
    mergedOffset += appliedPatchAssumptionCounts[patchIndex] ?? 0
  })

  return planAssumptions.map((assumption, index) => {
    const assessment = assessmentByIndex.get(index)
    return {
      claim: assumption.claim,
      dependentTaskKeys: assumption.dependentTaskKeys,
      ...(assessment ? { status: assessment.status, evidence: assessment.evidence } : {})
    }
  })
}

function buildPlanReviews(
  database: ObjectiveDatabase,
  reviews: readonly ObjectivePlanReviewProjection[]
): ObjectiveDetailPlanReview[] {
  return reviews.slice(0, PLAN_REVIEWS_MAX).map((review) => {
    const fullReport = getPlanReviewReport(database, review.id)
    if (!fullReport) {
      throw new Error(`Objective plan review ${review.id} report is missing`)
    }
    return {
      targetKind: review.targetKind,
      targetId: review.targetId,
      round: review.round,
      verdict: review.verdict,
      summary: fullReport.summary,
      createdAtMs: review.createdAtMs
    }
  })
}

/** The newest patch of the revision, when it still needs the owner's attention (pending or rejected). */
function buildPendingPatch(
  patches: readonly ObjectivePlanPatchProjection[],
  revisionId: string
): ObjectiveDetailPendingPatch | undefined {
  const newest = patches.find((patch) => patch.revisionId === revisionId)
  if (!newest || (newest.status !== 'pending' && newest.status !== 'rejected')) {
    return undefined
  }
  return {
    id: newest.id,
    status: newest.status,
    rejection: newest.rejection,
    touchedTaskKeys: newest.touchedTaskKeys
  }
}

function buildGate(
  gate: ObjectiveGate,
  attempts: readonly ObjectiveGateAttemptProjection[]
): ObjectiveDetailGate {
  let latest: ObjectiveGateAttemptProjection | undefined
  for (const attempt of attempts) {
    if (attempt.gateName !== gate.name || attempt.completedAtMs === null) {
      continue
    }
    if (!latest || attempt.completedAtMs > (latest.completedAtMs ?? -Infinity)) {
      latest = attempt
    }
  }
  if (!latest || latest.completedAtMs === null) {
    return { ...gate }
  }
  return {
    ...gate,
    lastResult: {
      contentIdentity: latest.contentIdentity,
      pass: latest.exitCode === 0 && latest.timedOut !== true,
      exitCode: latest.exitCode,
      timedOut: latest.timedOut === true,
      completedAtMs: latest.completedAtMs
    }
  }
}

/**
 * Builds the C12 plan-quality read model: per-node territory/overrun detail keyed by
 * `revisionId\0taskKey`, plus the objective-wide lint/assumption/review/patch/gate fields for
 * `ObjectiveDetail`. Territory and lint reflect the active (approved) revision, falling back to the
 * draft when none is approved yet; a pending/rejected repair patch is read only off the approved
 * revision, since patches apply to a plan already underway.
 */
export function buildObjectiveDetailPlanQuality(
  database: ObjectiveDatabase,
  watcherId: string,
  contract: ObjectiveEnrollmentPayload,
  projection: ObjectiveProjection
): ObjectiveDetailPlanQuality {
  const queries = new ObjectiveStoreQueries(database)
  const approvedRevision = projection.revisions.find((revision) => revision.status === 'approved')
  const focusRevision =
    approvedRevision ?? projection.revisions.find((revision) => revision.status === 'draft')

  const nodeDetailByKey = new Map<string, ObjectiveNodeTerritoryDetail>()
  let planLint: ObjectivePlanLint | undefined
  let assumptions: ObjectiveDetailAssumption[] | undefined

  if (focusRevision) {
    const report = queries.getPlanReport(focusRevision.id)
    if (report) {
      const dispatches = queries.listDispatches(watcherId)
      for (const task of report.plan) {
        nodeDetailByKey.set(
          `${focusRevision.id}\0${task.taskKey}`,
          buildNodeDetail(dispatches, focusRevision.id, task)
        )
      }
      planLint = lintObjectivePlan({
        plan: report.plan,
        assumptions: report.assumptions,
        writeTerritory: contract.writeTerritory,
        gates: contract.gates
      })
      if (report.assumptions) {
        assumptions = buildAssumptions(
          database,
          report.assumptions,
          projection.planReviews ?? [],
          projection.patches ?? [],
          focusRevision.id
        )
      }
    }
  }

  const planReviews = buildPlanReviews(database, projection.planReviews ?? [])
  const pendingPatch = approvedRevision
    ? buildPendingPatch(projection.patches ?? [], approvedRevision.id)
    : undefined
  const declaredGates = contract.gates ?? []
  const gates =
    declaredGates.length > 0
      ? declaredGates.map((gate) => buildGate(gate, projection.gateAttempts ?? []))
      : undefined

  return {
    nodeDetailByKey,
    ...(planLint ? { planLint } : {}),
    ...(assumptions ? { assumptions } : {}),
    ...(planReviews.length > 0 ? { planReviews } : {}),
    ...(pendingPatch ? { pendingPatch } : {}),
    ...(gates ? { gates } : { noGateDeclared: true })
  }
}
