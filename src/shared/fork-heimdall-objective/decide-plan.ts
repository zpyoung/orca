import type { WatcherLedger } from '../fork-heimdall/ledger-types'
import type { Snapshot } from '../fork-heimdall/snapshot'
import {
  activeObjectiveRevision,
  latestObjectiveAttempt,
  objectiveAttemptDisposition,
  objectiveAttemptReportValidation,
  objectiveNoAction,
  objectiveReportValidationDetail,
  type ObjectiveAttempt,
  type ObjectiveDecisionOutcome
} from './decision-context'
import { decidePlannerAction } from './decide-planner'
import { decideObjectivePlanReviewGate } from './decide-plan-review'
import { objectivePlanFailedDeviation } from './deviation-context'
import type {
  ObjectivePendingReport,
  ObjectiveRevisionProjection,
  ObjectiveWorld
} from './detail-types'
import { objectiveRepairEpisodeAttempts } from './objective-repair-state'

/**
 * Emits the apply for R's oldest unresolved plan patch, gated by plan review (C7). A patch already
 * `rejected` (an invalid repair report, a frozen-node conflict, or a round-1 plan-review `revise`)
 * never applies; falling through to the planner reuses its own retry/escalation budget instead of
 * stalling forever on a patch `decideObjectivePlan` would otherwise never revisit.
 */
function decideObjectivePlanPatchApplication(
  snapshot: Snapshot<ObjectiveWorld>,
  ledger: WatcherLedger,
  attempts: readonly ObjectiveAttempt[],
  reports: readonly ObjectivePendingReport[],
  revision: ObjectiveRevisionProjection
): ObjectiveDecisionOutcome | null {
  // scoped to the open episode: an older episode's rejected patch never blocked a later one from
  // being created, so an unbounded search could resurface it after the repair has moved on
  const { sinceOrdinal } = objectiveRepairEpisodeAttempts(snapshot.world, attempts, revision.id)
  const targetPatch = (snapshot.world.plan.patches ?? [])
    .filter(
      (patch) =>
        patch.revisionId === revision.id &&
        patch.repairOrdinal > sinceOrdinal &&
        patch.status !== 'applied'
    )
    .sort((left, right) => left.repairOrdinal - right.repairOrdinal)[0]
  if (!targetPatch) {
    return null
  }
  if (targetPatch.status === 'rejected') {
    // a plan-review-revise rejection recovers its findings from review history; any other rejection
    // needs 'replan-after-failure' so deriveObjectiveFailureContext can surface its rejection text
    return decidePlannerAction(
      snapshot,
      ledger,
      attempts,
      reports,
      targetPatch.rejection === 'plan-review-revise'
        ? 'replan-after-block'
        : 'replan-after-failure',
      revision.number
    )
  }
  const application = latestObjectiveAttempt(
    attempts,
    (action) => action.kind === 'apply-plan-patch' && action.patchId === targetPatch.id
  )
  if (application) {
    const disposition = objectiveAttemptDisposition(application.attempt, ledger)
    if (disposition === 'in-flight' || disposition === 'indeterminate') {
      return objectiveNoAction('plan', 'plan-activation-in-flight', targetPatch.id)
    }
    if (disposition === 'landed') {
      return objectiveNoAction('plan', 'projection-refresh-pending', targetPatch.id)
    }
  }
  return decideObjectivePlanReviewGate(
    snapshot,
    ledger,
    attempts,
    reports,
    { kind: 'patch', patch: targetPatch, revision },
    {
      kind: 'apply-plan-patch',
      capability: 'plan',
      visibility: 'local',
      recovery: 'replay-safe',
      contentIdentity: snapshot.contentIdentity,
      evidenceKey: targetPatch.id,
      revisionId: revision.id,
      patchId: targetPatch.id,
      digest: targetPatch.digest
    }
  )
}

export function decideObjectivePlan(
  snapshot: Snapshot<ObjectiveWorld>,
  ledger: WatcherLedger,
  attempts: readonly ObjectiveAttempt[],
  reports: readonly ObjectivePendingReport[],
  ownerConfigured = false
): ObjectiveDecisionOutcome | null {
  const approved = activeObjectiveRevision(snapshot.world)
  const draft = snapshot.world.plan.revisions
    .filter((candidate) => candidate.status === 'draft')
    .sort((left, right) => right.number - left.number)[0]
  if (!draft) {
    if (approved) {
      return decideObjectivePlanPatchApplication(snapshot, ledger, attempts, reports, approved)
    }
    // a round-1 plan-review `revise` is the only way a revision reaches 'rejected'; redispatching
    // against its own number (not 0) stops decidePlannerAction from treating its already-landed
    // ingest-plan as still pending and stalling on projection-refresh-pending forever
    const rejected = snapshot.world.plan.revisions
      .filter((candidate) => candidate.status === 'rejected')
      .sort((left, right) => right.number - left.number)[0]
    const planning = decidePlannerAction(
      snapshot,
      ledger,
      attempts,
      reports,
      rejected ? 'replan-after-block' : 'replan-after-failure',
      rejected?.number ?? 0
    )
    if (!ownerConfigured || rejected) {
      return planning
    }
    const planner = latestObjectiveAttempt(
      attempts,
      (action) => action.kind === 'dispatch-planner' && action.revisionNumber > 0
    )
    const report = reports.find((candidate) => candidate.dispatchId === planner?.attempt.dispatchId)
    const ingestion =
      report?.outcome === 'succeeded' && report.reportPath !== null
        ? latestObjectiveAttempt(
            attempts,
            (action) => action.kind === 'ingest-plan' && action.dispatchId === report.dispatchId
          )
        : null
    const validation =
      report?.reportValidation ??
      ((ingestion && objectiveAttemptReportValidation(ingestion.attempt, ledger)) ||
        (planner && objectiveAttemptReportValidation(planner.attempt, ledger)))
    const evidenceDetail =
      report?.evidenceIssue === 'files-modified-malformed'
        ? 'report rejected: evidence-malformed; role=planner; hostVerifiable=true\nWorker completion filesModified must be an array of workspace-relative paths'
        : validation
          ? objectiveReportValidationDetail(validation)
          : report?.body
    if (
      planner &&
      ((report !== undefined &&
        (report.outcome === 'failed' ||
          report.reportPath === null ||
          report.evidenceIssue === 'files-modified-malformed')) ||
        validation !== null ||
        planning.action?.kind === 'dispatch-planner')
    ) {
      return {
        action: null,
        deviation: objectivePlanFailedDeviation({
          reason: 'no-usable-plan',
          ...(evidenceDetail === undefined ? {} : { detail: evidenceDetail })
        })
      }
    }
    return planning
  }
  const activation = latestObjectiveAttempt(
    attempts,
    (action) => action.kind === 'activate-plan' && action.revisionId === draft.id
  )
  if (activation) {
    const disposition = objectiveAttemptDisposition(activation.attempt, ledger)
    if (disposition === 'in-flight' || disposition === 'indeterminate') {
      return objectiveNoAction('plan', 'plan-activation-in-flight', draft.id)
    }
    if (disposition === 'landed') {
      return objectiveNoAction('plan', 'projection-refresh-pending', draft.id)
    }
    if (ownerConfigured) {
      return {
        action: null,
        deviation: objectivePlanFailedDeviation({
          reason: 'activation-not-landed',
          revisionId: draft.id,
          revisionNumber: draft.number
        })
      }
    }
    return decidePlannerAction(
      snapshot,
      ledger,
      attempts,
      reports,
      'replan-after-failure',
      draft.number
    )
  }
  return decideObjectivePlanReviewGate(
    snapshot,
    ledger,
    attempts,
    reports,
    { kind: 'revision', revision: draft },
    {
      kind: 'activate-plan',
      capability: 'plan',
      visibility: 'local',
      recovery: 'replay-safe',
      contentIdentity: snapshot.contentIdentity,
      evidenceKey: draft.id,
      revisionId: draft.id,
      digest: draft.digest
    }
  )
}
