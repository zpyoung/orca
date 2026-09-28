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
import type { ObjectivePendingReport, ObjectiveWorld } from './detail-types'
import type { DispatchPlannerAction } from './objective-actions'
import {
  nextObjectiveRepairOrdinal,
  objectiveRepairEpisodeAttempts
} from './objective-repair-state'

/** One retry after a rejected repair patch; the attempt after that escalates (C8). */
const REPAIR_ESCALATION_REJECTED_PATCH_THRESHOLD = 2

/**
 * A repair report that could not even be read (missing file, non-JSON) never reaches a stored
 * patch — its `ingest-plan` attempt just settles not-landed. Counts those alongside
 * `rejectedPatchCount` so an unreadable report consumes the retry budget exactly as a stored
 * `invalid-report:` rejection does (X1), instead of letting the episode redispatch unbounded.
 */
function notLandedRepairIngestionCount(
  ledger: WatcherLedger,
  attempts: readonly ObjectiveAttempt[],
  revisionId: string,
  sinceOrdinal: number
): number {
  const ordinalByDispatchId = new Map<string, number>()
  for (const { attempt, action } of attempts) {
    if (
      action.kind === 'dispatch-planner' &&
      action.plannerMode === 'repair' &&
      action.repairRevisionId === revisionId &&
      action.repairOrdinal !== undefined &&
      attempt.dispatchId !== undefined
    ) {
      ordinalByDispatchId.set(attempt.dispatchId, action.repairOrdinal)
    }
  }
  let count = 0
  for (const { attempt, action } of attempts) {
    if (
      action.kind !== 'ingest-plan' ||
      action.plannerMode !== 'repair' ||
      action.targetRevisionId !== revisionId
    ) {
      continue
    }
    const ordinal = ordinalByDispatchId.get(action.dispatchId)
    if (
      ordinal === undefined ||
      ordinal <= sinceOrdinal ||
      objectiveAttemptDisposition(attempt, ledger) !== 'not-landed'
    ) {
      continue
    }
    count += 1
  }
  return count
}

/**
 * `decidePlannerAction`'s counterpart once an approved revision exists: every redispatch patches
 * that revision instead of replacing it, so this never mints a new revision number.
 */
export function decideRepairPlannerAction(
  snapshot: Snapshot<ObjectiveWorld>,
  ledger: WatcherLedger,
  attempts: readonly ObjectiveAttempt[],
  reports: readonly ObjectivePendingReport[],
  reason: DispatchPlannerAction['reason']
): ObjectiveDecisionOutcome {
  const revision = activeObjectiveRevision(snapshot.world)
  if (!revision) {
    throw new Error('decideRepairPlannerAction requires an approved revision')
  }
  const revisionId = revision.id
  const episode = objectiveRepairEpisodeAttempts(snapshot.world, attempts, revisionId)
  const latest = episode.latestAttempt

  if (latest?.action.kind === 'dispatch-planner') {
    const disposition = objectiveAttemptDisposition(latest.attempt, ledger)
    if (disposition === 'in-flight' || disposition === 'indeterminate') {
      return objectiveNoAction('plan', 'planner-in-flight', latest.action.evidenceKey)
    }
    const report = reports.find((candidate) => candidate.dispatchId === latest.attempt.dispatchId)
    const reportValidation = objectiveAttemptReportValidation(latest.attempt, ledger)
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
      if (!ingestion) {
        return {
          action: {
            kind: 'ingest-plan',
            capability: 'plan',
            visibility: 'local',
            recovery: 'replay-safe',
            contentIdentity: snapshot.contentIdentity,
            evidenceKey: report.dispatchId,
            dispatchId: report.dispatchId,
            // sourced from the dispatch that produced this report, not recomputed, so an
            // owner-directed dispatch's revisionNumber is guaranteed to match on ingest
            revisionNumber: latest.action.revisionNumber,
            reportPath: report.reportPath,
            plannerMode: 'repair',
            targetRevisionId: revisionId
          }
        }
      }
      const ingestionDisposition = objectiveAttemptDisposition(ingestion.attempt, ledger)
      if (ingestionDisposition === 'in-flight' || ingestionDisposition === 'indeterminate') {
        return objectiveNoAction('plan', 'plan-ingestion-in-flight', report.dispatchId)
      }
      if (ingestionDisposition === 'landed') {
        const patch = (snapshot.world.plan.patches ?? []).find(
          (candidate) => candidate.createdByDispatchId === report.dispatchId
        )
        if (!patch) {
          return objectiveNoAction('plan', 'projection-refresh-pending', report.dispatchId)
        }
      }
    }
  }

  const pendingPatch = (snapshot.world.plan.patches ?? []).find(
    (candidate) =>
      candidate.revisionId === revisionId &&
      candidate.repairOrdinal > episode.sinceOrdinal &&
      candidate.status === 'pending'
  )
  if (pendingPatch) {
    return objectiveNoAction('plan', 'plan-repair-pending', pendingPatch.id)
  }

  const repairOrdinal = nextObjectiveRepairOrdinal(snapshot.world, attempts, revisionId)
  const consumedRetryBudget =
    episode.rejectedPatchCount +
    notLandedRepairIngestionCount(ledger, attempts, revisionId, episode.sinceOrdinal)
  return {
    action: {
      kind: 'dispatch-planner',
      capability: 'plan',
      visibility: 'local',
      contentIdentity: snapshot.contentIdentity,
      evidenceKey: `plan-repair:${revisionId}:${repairOrdinal}`,
      revisionNumber: revision.number,
      reason,
      plannerMode: 'repair',
      repairOrdinal,
      repairRevisionId: revisionId,
      ...(consumedRetryBudget >= REPAIR_ESCALATION_REJECTED_PATCH_THRESHOLD
        ? { approvalRequired: true }
        : {})
    }
  }
}
