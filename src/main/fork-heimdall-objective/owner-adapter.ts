import type {
  OwnerAdapter,
  OwnerInterventionRejection
} from '../../shared/fork-heimdall/kind-contract'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { Intervention } from '../../shared/fork-heimdall/owner/intervention'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import {
  OBJECTIVE_LANDING_LADDER,
  stopRungForBar
} from '../../shared/fork-heimdall-objective/landing-ladder'
import type { ObjectiveAction } from '../../shared/fork-heimdall-objective/objective-actions'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import {
  describeObjectiveInterventions,
  ObjectiveOwnerInterventionSchema,
  ObjectiveSpecificInterventionSchema,
  type AcceptReportIntervention,
  type SkipStageIntervention
} from '../../shared/fork-heimdall-objective/owner-intervention'
import { objectivePathMatchesTerritory } from '../../shared/fork-heimdall-objective/plan-schema'
import { objectiveActionForIntervention } from './owner-adapter-actions'
import { describeObjectiveOwnerState } from './owner-adapter-state'
import { findRejectedIngestReportAttempt, rejectedReportAudit } from './owner-override-executor'

/** Gate 1: an attestation may excuse a reported-vs-observed mismatch, never a territory violation. */
function rejectAcceptReport(
  intervention: AcceptReportIntervention,
  snapshot: Snapshot<ObjectiveWorld>,
  ledger: WatcherLedger
): OwnerInterventionRejection | null {
  const rejected = findRejectedIngestReportAttempt(ledger, intervention.dispatchId)
  if (!rejected) {
    return null
  }
  const audit = rejectedReportAudit(rejected)
  const territory = snapshot.world.contract.writeTerritory
  const outside = [...audit.reportedFiles, ...audit.observedFiles].find(
    (path) => !objectivePathMatchesTerritory(path, territory)
  )
  return outside
    ? {
        gate: 'write-territory',
        reason: `accept-report cannot excuse a change outside write territory: ${outside}`
      }
    : null
}

/**
 * Gate 2: refuses a landing-ladder rung this watcher's bar mandates reaching. The tier-driven
 * stages — `reviewer`, `integrator`, `checks` — are never in the ladder, so the bar has no opinion
 * on them and this always allows them; `skip-review`/`skip-check`'s own capability gate is what
 * still governs whether the owner may apply them.
 */
function rejectSkipStage(
  intervention: SkipStageIntervention,
  snapshot: Snapshot<ObjectiveWorld>
): OwnerInterventionRejection | null {
  const bar = snapshot.world.contract.landingBar
  const stopIndex = OBJECTIVE_LANDING_LADDER.indexOf(stopRungForBar(bar))
  const mandated: readonly string[] = OBJECTIVE_LANDING_LADDER.slice(0, stopIndex + 1)
  return mandated.includes(intervention.stage)
    ? {
        gate: 'landing-bar',
        reason: `stage "${intervention.stage}" is mandated by the ${bar} landing bar and cannot be skipped`
      }
    : null
}

export function objectiveRejectIntervention(
  intervention: Intervention,
  snapshot: Snapshot<ObjectiveWorld>,
  ledger: WatcherLedger,
  _enrollment: WatcherEnrollment
): OwnerInterventionRejection | null {
  const parsed = ObjectiveSpecificInterventionSchema.safeParse(intervention)
  if (!parsed.success) {
    return null
  }
  switch (parsed.data.kind) {
    case 'accept-report':
      return rejectAcceptReport(parsed.data, snapshot, ledger)
    case 'skip-stage':
      return rejectSkipStage(parsed.data, snapshot)
    case 'retry-node':
    case 'skip-node':
    case 'amend-plan':
    case 'dispatch-planner':
    case 'set-role-agent':
      // none of these grants a sitter capability or otherwise crosses gate 1, 2 or 4
      return null
  }
}

export function createObjectiveOwnerAdapter(): OwnerAdapter<ObjectiveWorld, ObjectiveAction> {
  return {
    describeState: describeObjectiveOwnerState,
    describeInterventions: describeObjectiveInterventions,
    interventionSchema: ObjectiveOwnerInterventionSchema,
    rejectIntervention: objectiveRejectIntervention,
    actionForIntervention: objectiveActionForIntervention
  }
}
