import type { WatcherLedger } from '../fork-heimdall/ledger-types'
import {
  latestObjectiveAttempt,
  objectiveAttemptDisposition,
  objectiveAttemptReportValidation,
  objectiveInFlightTaskKeys,
  projectObjectiveReports,
  type ObjectiveAttempt
} from './decision-context'
import type { ObjectiveWorld } from './detail-types'

const RUNNING_DISPATCH_STATES = new Set([
  'running',
  'waiting-to-apply',
  'applying',
  'resolving-conflict'
])

/**
 * Task keys a repair patch must not touch: the approved revision's succeeded-or-dispatched nodes,
 * anything with an unsettled `dispatch-node` attempt, and any parallel dispatch still running or
 * queued to apply. A finished-but-unmerged dispatch is running work; amending it would discard it.
 */
export function objectiveFrozenTaskKeys(
  world: ObjectiveWorld,
  ledger: WatcherLedger,
  revisionId: string
): Set<string> {
  const frozen = new Set<string>()
  for (const node of world.plan.nodes) {
    if (
      node.revisionId === revisionId &&
      (node.state === 'succeeded' || node.state === 'dispatched')
    ) {
      frozen.add(node.taskKey)
    }
  }
  for (const taskKey of objectiveInFlightTaskKeys(ledger, revisionId)) {
    frozen.add(taskKey)
  }
  for (const dispatch of world.parallel?.dispatches ?? []) {
    if (dispatch.revisionId === revisionId && RUNNING_DISPATCH_STATES.has(dispatch.state)) {
      frozen.add(dispatch.taskKey)
    }
  }
  return frozen
}

/**
 * The next repair ordinal for a revision: one past the highest ordinal already claimed by a repair
 * `dispatch-planner` attempt or a stored plan patch for that revision, so a replayed decision and a
 * replayed store write agree on the same number.
 */
export function nextObjectiveRepairOrdinal(
  world: ObjectiveWorld,
  attempts: readonly ObjectiveAttempt[],
  revisionId: string
): number {
  let highest = 0
  for (const { action } of attempts) {
    if (
      action.kind === 'dispatch-planner' &&
      action.plannerMode === 'repair' &&
      action.repairRevisionId === revisionId &&
      action.repairOrdinal !== undefined
    ) {
      highest = Math.max(highest, action.repairOrdinal)
    }
  }
  for (const patch of world.plan.patches ?? []) {
    if (patch.revisionId === revisionId) {
      highest = Math.max(highest, patch.repairOrdinal)
    }
  }
  return highest + 1
}

/** The ordinal of R's most recently applied patch, or 0 when none has applied yet. */
function latestAppliedPatchOrdinal(world: ObjectiveWorld, revisionId: string): number {
  let highest = 0
  for (const patch of world.plan.patches ?? []) {
    if (patch.revisionId === revisionId && patch.status === 'applied') {
      highest = Math.max(highest, patch.repairOrdinal)
    }
  }
  return highest
}

export type ObjectiveRepairEpisodeAttempts = {
  /** Repair ordinal boundary: attempts/patches at or below this ordinal belong to a closed episode. */
  sinceOrdinal: number
  latestAttempt: ObjectiveAttempt | null
  rejectedPatchCount: number
}

/**
 * The current repair episode for revision R: its most recent repair `dispatch-planner` attempt and
 * how many of its patches were rejected, scoped to what happened since R's last applied patch (or
 * since activation when none has applied). An applied patch always starts a fresh episode with a
 * reset retry budget.
 */
export function objectiveRepairEpisodeAttempts(
  world: ObjectiveWorld,
  attempts: readonly ObjectiveAttempt[],
  revisionId: string
): ObjectiveRepairEpisodeAttempts {
  const sinceOrdinal = latestAppliedPatchOrdinal(world, revisionId)
  const latestAttempt = latestObjectiveAttempt(
    attempts,
    (action) =>
      action.kind === 'dispatch-planner' &&
      action.plannerMode === 'repair' &&
      action.repairRevisionId === revisionId &&
      (action.repairOrdinal ?? 0) > sinceOrdinal
  )
  let rejectedPatchCount = 0
  for (const patch of world.plan.patches ?? []) {
    if (
      patch.revisionId === revisionId &&
      patch.repairOrdinal > sinceOrdinal &&
      patch.status === 'rejected'
    ) {
      rejectedPatchCount += 1
    }
  }
  return { sinceOrdinal, latestAttempt, rejectedPatchCount }
}

/**
 * Whether R's repair episode is still open: its latest repair `dispatch-planner` attempt is
 * unsettled, has a landed worker report not yet ingested, or produced a patch still `pending`.
 * Closed exactly when a patch has applied or been rejected and no newer repair attempt has started.
 */
export function objectiveRepairEpisodeOpen(
  world: ObjectiveWorld,
  ledger: WatcherLedger,
  attempts: readonly ObjectiveAttempt[],
  revisionId: string
): boolean {
  const { latestAttempt } = objectiveRepairEpisodeAttempts(world, attempts, revisionId)
  if (!latestAttempt || latestAttempt.action.kind !== 'dispatch-planner') {
    return false
  }
  const disposition = objectiveAttemptDisposition(latestAttempt.attempt, ledger)
  if (disposition === 'in-flight' || disposition === 'indeterminate') {
    return true
  }
  const reports = projectObjectiveReports(ledger)
  const report = reports.find(
    (candidate) => candidate.dispatchId === latestAttempt.attempt.dispatchId
  )
  const reportValidation = objectiveAttemptReportValidation(latestAttempt.attempt, ledger)
  const reportSucceeded =
    report?.outcome === 'succeeded' &&
    report.reportPath !== null &&
    report.evidenceIssue === undefined &&
    report.reportValidation === undefined &&
    reportValidation === null
  if (!reportSucceeded) {
    return false
  }
  const ingestion = latestObjectiveAttempt(
    attempts,
    (action) => action.kind === 'ingest-plan' && action.dispatchId === report.dispatchId
  )
  if (!ingestion) {
    return true
  }
  const ingestionDisposition = objectiveAttemptDisposition(ingestion.attempt, ledger)
  if (ingestionDisposition === 'in-flight' || ingestionDisposition === 'indeterminate') {
    return true
  }
  if (ingestionDisposition !== 'landed') {
    return false
  }
  const patch = (world.plan.patches ?? []).find(
    (candidate) => candidate.createdByDispatchId === report.dispatchId
  )
  return !patch || patch.status === 'pending'
}
