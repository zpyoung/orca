import type { WatcherLedger } from '../fork-heimdall/ledger-types'
import type { Snapshot } from '../fork-heimdall/snapshot'
import {
  activeObjectiveRevision,
  decidePlannerAction,
  latestObjectiveAttempt,
  objectiveAttemptDisposition,
  objectiveAttemptReportValidation,
  objectiveNoAction,
  objectiveReportValidationDetail,
  type ObjectiveAttempt,
  type ObjectiveDecisionOutcome
} from './decision-context'
import { objectivePlanFailedDeviation } from './deviation-context'
import type { ObjectivePendingReport, ObjectiveWorld } from './detail-types'

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
      return null
    }
    const planning = decidePlannerAction(
      snapshot,
      ledger,
      attempts,
      reports,
      'replan-after-failure',
      0
    )
    if (!ownerConfigured) {
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
  return {
    action: {
      kind: 'activate-plan',
      capability: 'plan',
      visibility: 'local',
      recovery: 'replay-safe',
      contentIdentity: snapshot.contentIdentity,
      evidenceKey: draft.id,
      revisionId: draft.id,
      digest: draft.digest
    }
  }
}
