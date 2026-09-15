import type { WatcherLedger } from '../fork-heimdall/ledger-types'
import type { Snapshot } from '../fork-heimdall/snapshot'
import {
  activeObjectiveRevision,
  decidePlannerAction,
  latestObjectiveAttempt,
  objectiveAttempts,
  objectiveAttemptDisposition,
  objectiveNoAction,
  projectObjectiveReports,
  type ObjectiveDecisionOutcome,
  type ObjectiveNoActionReason
} from './decision-context'
import { decideObjectiveNodes } from './decide-nodes'
import { decideObjectivePlan } from './decide-plan'
import { decideObjectiveChecks, decideObjectiveReview } from './decide-review'
import type { ObjectiveWorld } from './detail-types'

export type { ObjectiveDecisionOutcome, ObjectiveNoActionReason }
export { projectObjectiveReports }

export function decideObjective(
  snapshot: Snapshot<ObjectiveWorld>,
  ledger: WatcherLedger
): ObjectiveDecisionOutcome {
  const landed = snapshot.world.plan.landing.some(
    (entry) => entry.rung === 'files-on-disk' && entry.contentIdentity === snapshot.contentIdentity
  )
  if (landed) {
    return objectiveNoAction(
      'landing',
      snapshot.world.contract.landingBar === 'files-on-disk' ? 'landed-at-bar' : 'awaiting-phase-4',
      snapshot.world.contract.landingBar
    )
  }

  const attempts = objectiveAttempts(ledger)
  const reports = projectObjectiveReports(ledger)
  const planDecision = decideObjectivePlan(snapshot, ledger, attempts, reports)
  if (planDecision) {
    return planDecision
  }
  const revision = activeObjectiveRevision(snapshot.world)
  if (!revision) {
    return objectiveNoAction('plan', 'projection-refresh-pending')
  }
  const nodeDecision = decideObjectiveNodes(snapshot, ledger, attempts, reports, revision)
  if (nodeDecision) {
    return nodeDecision
  }
  const checkDecision = decideObjectiveChecks(snapshot, ledger, attempts, reports, revision)
  if (checkDecision) {
    return checkDecision
  }
  const reviewDecision = decideObjectiveReview(snapshot, ledger, attempts, reports, revision)
  if (reviewDecision) {
    return reviewDecision
  }

  const landing = latestObjectiveAttempt(
    attempts,
    (action) =>
      action.kind === 'record-landing' && action.contentIdentity === snapshot.contentIdentity
  )
  if (landing) {
    if (objectiveAttemptDisposition(landing.attempt, ledger) === 'not-landed') {
      return decidePlannerAction(
        snapshot,
        ledger,
        attempts,
        reports,
        'replan-after-failure',
        revision.number
      )
    }
    return objectiveNoAction('landing', 'landing-in-flight', snapshot.contentIdentity)
  }
  return {
    action: {
      kind: 'record-landing',
      capability: 'land',
      visibility: 'local',
      recovery: 'replay-safe',
      contentIdentity: snapshot.contentIdentity,
      evidenceKey: `files-on-disk:${snapshot.contentIdentity}`,
      rung: 'files-on-disk',
      revisionId: revision.id
    }
  }
}

export const computeObjectiveAction = decideObjective
