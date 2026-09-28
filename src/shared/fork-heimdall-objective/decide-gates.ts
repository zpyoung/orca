import type { WatcherLedger } from '../fork-heimdall/ledger-types'
import type { Snapshot } from '../fork-heimdall/snapshot'
import type { ObjectiveGate } from './contract-types'
import { objectiveCheckFailedDeviation } from './deviation-context'
import {
  latestObjectiveAttempt,
  objectiveAttemptDisposition,
  objectiveNoAction,
  type ObjectiveAttempt,
  type ObjectiveDecisionOutcome
} from './decision-context'
import { decidePlannerAction } from './decide-planner'
import {
  objectiveReadOnlyWorkerInFlight,
  objectiveStaleEvidenceReissueEvidenceKey
} from './decide-stale-evidence'
import type {
  ObjectivePendingReport,
  ObjectiveRevisionProjection,
  ObjectiveWorld
} from './detail-types'
import { lineageBaseIdentity } from './landing-ladder'

type GateClassification =
  | { status: 'passed' }
  | { status: 'failed'; exitCode: number | null; timedOut: boolean; detail?: string }
  | { status: 'in-flight' }
  | { status: 'missing' }
  | { status: 'stale-reissue'; evidenceKey: string }

/**
 * A gate is keyed like a check (lineage identity, not the raw snapshot identity) so a rebase back
 * onto content already gated does not re-run it, but the in-flight ledger lookup below still keys
 * on the raw identity because that is what a freshly dispatched `run-gate` action was stamped with.
 */
function classifyGate(
  gate: ObjectiveGate,
  snapshot: Snapshot<ObjectiveWorld>,
  ledger: WatcherLedger,
  attempts: readonly ObjectiveAttempt[],
  lineageIdentity: string
): GateClassification {
  const completed = (snapshot.world.plan.gateAttempts ?? []).find(
    (candidate) =>
      candidate.gateName === gate.name &&
      candidate.contentIdentity === lineageIdentity &&
      candidate.completedAtMs !== null
  )
  if (completed) {
    const timedOut = completed.timedOut ?? false
    return completed.exitCode === 0 && !timedOut
      ? { status: 'passed' }
      : { status: 'failed', exitCode: completed.exitCode, timedOut }
  }

  const inFlight = latestObjectiveAttempt(
    attempts,
    (action) =>
      action.kind === 'run-gate' &&
      action.gateName === gate.name &&
      action.contentIdentity === snapshot.contentIdentity
  )
  if (!inFlight) {
    return { status: 'missing' }
  }
  const disposition = objectiveAttemptDisposition(inFlight.attempt, ledger)
  if (disposition === 'not-landed') {
    if (inFlight.attempt.reason === 'check-evidence-stale') {
      const reissueEvidenceKey = objectiveStaleEvidenceReissueEvidenceKey(
        `objective-gate:${gate.name}:${snapshot.contentIdentity}`,
        attempts,
        ledger,
        (action) =>
          action.kind === 'run-gate' &&
          action.gateName === gate.name &&
          action.contentIdentity === snapshot.contentIdentity
      )
      if (reissueEvidenceKey) {
        return { status: 'stale-reissue', evidenceKey: reissueEvidenceKey }
      }
    }
    return {
      status: 'failed',
      exitCode: null,
      timedOut: false,
      detail: 'the gate attempt itself failed to land'
    }
  }
  return { status: 'in-flight' }
}

export function decideObjectiveGates(
  snapshot: Snapshot<ObjectiveWorld>,
  ledger: WatcherLedger,
  attempts: readonly ObjectiveAttempt[],
  reports: readonly ObjectivePendingReport[],
  revision: ObjectiveRevisionProjection,
  ownerConfigured = false
): ObjectiveDecisionOutcome | null {
  const gates = snapshot.world.contract.gates
  if (!gates || gates.length === 0) {
    return null
  }
  const lineageIdentity = lineageBaseIdentity(snapshot.world.plan.landing, snapshot.contentIdentity)
  const classified = gates.map((gate) => ({
    gate,
    classification: classifyGate(gate, snapshot, ledger, attempts, lineageIdentity)
  }))

  const staleReissue = classified.find(
    (
      entry
    ): entry is {
      gate: ObjectiveGate
      classification: Extract<GateClassification, { status: 'stale-reissue' }>
    } => entry.classification.status === 'stale-reissue'
  )
  const missing = classified.find((entry) => entry.classification.status === 'missing')
  if (staleReissue) {
    if (objectiveReadOnlyWorkerInFlight(attempts, ledger)) {
      return objectiveNoAction('gates', 'read-only-worker-in-flight')
    }
    return {
      action: {
        kind: 'run-gate',
        capability: 'check',
        visibility: 'local',
        contentIdentity: snapshot.contentIdentity,
        evidenceKey: staleReissue.classification.evidenceKey,
        gateName: staleReissue.gate.name,
        command: staleReissue.gate.command,
        timeoutSeconds: staleReissue.gate.timeoutSeconds
      }
    }
  }

  const failed = classified.find(
    (
      entry
    ): entry is {
      gate: ObjectiveGate
      classification: Extract<GateClassification, { status: 'failed' }>
    } => entry.classification.status === 'failed'
  )
  if (failed) {
    if (ownerConfigured) {
      return {
        action: null,
        deviation: objectiveCheckFailedDeviation({
          criterionId: `objective-gate:${failed.gate.name}`,
          command: failed.gate.command,
          exitCode: failed.classification.exitCode,
          timedOut: failed.classification.timedOut,
          ...(failed.classification.detail === undefined
            ? {}
            : { detail: failed.classification.detail })
        })
      }
    }
    return decidePlannerAction(
      snapshot,
      ledger,
      attempts,
      reports,
      'replan-after-failure',
      revision.number
    )
  }

  if (missing) {
    if (objectiveReadOnlyWorkerInFlight(attempts, ledger)) {
      return objectiveNoAction('gates', 'read-only-worker-in-flight')
    }
    return {
      action: {
        kind: 'run-gate',
        capability: 'check',
        visibility: 'local',
        contentIdentity: snapshot.contentIdentity,
        evidenceKey: `objective-gate:${missing.gate.name}:${snapshot.contentIdentity}`,
        gateName: missing.gate.name,
        command: missing.gate.command,
        timeoutSeconds: missing.gate.timeoutSeconds
      }
    }
  }

  if (classified.some((entry) => entry.classification.status === 'in-flight')) {
    return objectiveNoAction('gates', 'gate-in-flight')
  }

  return null
}
