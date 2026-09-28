import type { WatcherLedger } from '../fork-heimdall/ledger-types'
import type { Snapshot } from '../fork-heimdall/snapshot'
import {
  activeObjectiveRevision,
  latestObjectiveAttempt,
  objectiveAttemptDisposition,
  objectiveAttemptReportValidation,
  objectiveNoAction,
  type ObjectiveAttempt,
  type ObjectiveDecisionOutcome
} from './decision-context'
import { decideRepairPlannerAction } from './decide-repair-planner'
import type { ObjectivePendingReport, ObjectiveWorld } from './detail-types'
import type { DispatchPlannerAction } from './objective-actions'

function highestRevisionNumber(
  world: ObjectiveWorld,
  attempts: readonly ObjectiveAttempt[]
): number {
  let highest = world.plan.revisions.reduce(
    (maximum, revision) => Math.max(maximum, revision.number),
    0
  )
  for (const { action } of attempts) {
    if (action.kind === 'dispatch-planner') {
      highest = Math.max(highest, action.revisionNumber)
    }
  }
  return highest
}

export function decidePlannerAction(
  snapshot: Snapshot<ObjectiveWorld>,
  ledger: WatcherLedger,
  attempts: readonly ObjectiveAttempt[],
  reports: readonly ObjectivePendingReport[],
  reason: DispatchPlannerAction['reason'],
  afterRevisionNumber: number
): ObjectiveDecisionOutcome {
  // an approved revision turns every redispatch into a patch against it, never a new revision
  if (activeObjectiveRevision(snapshot.world)) {
    return decideRepairPlannerAction(snapshot, ledger, attempts, reports, reason)
  }
  const planner = latestObjectiveAttempt(
    attempts,
    (action) => action.kind === 'dispatch-planner' && action.revisionNumber > afterRevisionNumber
  )
  if (planner?.action.kind === 'dispatch-planner') {
    const disposition = objectiveAttemptDisposition(planner.attempt, ledger)
    const report = reports.find((candidate) => candidate.dispatchId === planner.attempt.dispatchId)
    const reportValidation = objectiveAttemptReportValidation(planner.attempt, ledger)
    if (
      report?.outcome === 'succeeded' &&
      report.reportPath !== null &&
      report.evidenceIssue === undefined &&
      report.reportValidation === undefined &&
      reportValidation === null
    ) {
      const ingestion = latestObjectiveAttempt(
        attempts,
        (action) => action.kind === 'ingest-plan' && action.dispatchId === report.dispatchId
      )
      if (ingestion) {
        const ingestionDisposition = objectiveAttemptDisposition(ingestion.attempt, ledger)
        if (ingestionDisposition === 'in-flight' || ingestionDisposition === 'indeterminate') {
          return objectiveNoAction('plan', 'plan-ingestion-in-flight', report.dispatchId)
        }
        if (ingestionDisposition === 'landed') {
          return objectiveNoAction('plan', 'projection-refresh-pending', report.dispatchId)
        }
      } else {
        return {
          action: {
            kind: 'ingest-plan',
            capability: 'plan',
            visibility: 'local',
            recovery: 'replay-safe',
            contentIdentity: snapshot.contentIdentity,
            evidenceKey: report.dispatchId,
            dispatchId: report.dispatchId,
            revisionNumber: planner.action.revisionNumber,
            reportPath: report.reportPath
          }
        }
      }
    }
    if (disposition === 'in-flight' || disposition === 'indeterminate') {
      return objectiveNoAction('plan', 'planner-in-flight', planner.action.evidenceKey)
    }
  }

  const revisionNumber = highestRevisionNumber(snapshot.world, attempts) + 1
  return {
    action: {
      kind: 'dispatch-planner',
      capability: 'plan',
      visibility: 'local',
      contentIdentity: snapshot.contentIdentity,
      evidenceKey: `plan:${revisionNumber}`,
      revisionNumber,
      reason: revisionNumber === 1 ? 'initial' : reason,
      plannerMode: 'full'
    }
  }
}
