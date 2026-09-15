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
import type { ObjectivePendingReport, ObjectiveWorld } from './detail-types'

export function decideObjectivePlan(
  snapshot: Snapshot<ObjectiveWorld>,
  ledger: WatcherLedger,
  attempts: readonly ObjectiveAttempt[],
  reports: readonly ObjectivePendingReport[]
): ObjectiveDecisionOutcome | null {
  const approved = activeObjectiveRevision(snapshot.world)
  const draft = snapshot.world.plan.revisions
    .filter((candidate) => candidate.status === 'draft')
    .sort((left, right) => right.number - left.number)[0]
  if (!draft) {
    return approved
      ? null
      : decidePlannerAction(snapshot, ledger, attempts, reports, 'replan-after-failure', 0)
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
