import type { StopPredicate } from '../fork-heimdall/stop-policy'
import { getAttemptResolution } from '../fork-heimdall/ledger-queries'
import type { Snapshot } from '../fork-heimdall/snapshot'
import type { WatcherLedger } from '../fork-heimdall/ledger-types'
import { ownerDeviationEscalationId, type Deviation } from '../fork-heimdall/owner/deviation'
import {
  objectiveAttemptDisposition,
  objectiveAttempts,
  type ObjectiveAttempt
} from './decision-context'
import { objectiveLandingFailedDeviation } from './deviation-context'
import type { ObjectiveWorld } from './detail-types'
import type { ObjectiveAction } from './objective-actions'

type LandingStuckVerdict = {
  deviation: Deviation
  reason: string
  detail: string
}

export const OBJECTIVE_LANDING_STUCK_PREDICATE_ID = 'objective-landing-stuck'
export const OBJECTIVE_LANDING_STUCK_WINDOW_MS = 30 * 60 * 1_000

type StuckLandingAction = Extract<
  ObjectiveAction,
  { kind: 'commit-local-branch' | 'push-ref' | 'open-hosted-review' }
>

type StuckLandingAttempt = {
  attempt: ObjectiveAttempt['attempt']
  action: StuckLandingAction
  disposition: 'not-landed' | 'indeterminate'
  resolutionAtMs: number | null
  reason: string | null
}

function isStuckLandingAction(action: ObjectiveAction): action is StuckLandingAction {
  return (
    action.kind === 'commit-local-branch' ||
    action.kind === 'push-ref' ||
    action.kind === 'open-hosted-review'
  )
}

function latestStuckLandingAttempt(
  snapshot: Snapshot<ObjectiveWorld>,
  ledger: WatcherLedger
): StuckLandingAttempt | null {
  let latestAttempt: ObjectiveAttempt['attempt'] | null = null
  let latestAction: StuckLandingAction | null = null
  for (const candidate of objectiveAttempts(ledger)) {
    const action = candidate.action
    if (
      !isStuckLandingAction(action) ||
      action.contentIdentity !== snapshot.contentIdentity ||
      (latestAttempt !== null && candidate.attempt.atMs < latestAttempt.atMs)
    ) {
      continue
    }
    latestAttempt = candidate.attempt
    latestAction = action
  }
  if (latestAttempt === null || latestAction === null) {
    return null
  }
  const resolution = getAttemptResolution(ledger, latestAttempt.attemptId)
  const disposition = objectiveAttemptDisposition(latestAttempt, ledger)
  if (disposition !== 'not-landed' && disposition !== 'indeterminate') {
    return null
  }
  return {
    attempt: latestAttempt,
    action: latestAction,
    disposition,
    resolutionAtMs: resolution?.atMs ?? null,
    reason: resolution ? `attempt-resolved:${resolution.effect}` : (latestAttempt.reason ?? null)
  }
}

function latestOwnerResolutionAtMs(ledger: WatcherLedger, escalationId: string): number | null {
  let latest: number | null = null
  for (const entry of ledger.entries) {
    if (
      entry.kind === 'escalation' &&
      entry.escalationKind === 'owner-deviation' &&
      entry.escalationId === escalationId &&
      entry.status === 'resolved'
    ) {
      latest = entry.atMs
    }
  }
  return latest
}

function landingStuckVerdict(
  snapshot: Snapshot<ObjectiveWorld>,
  ledger: WatcherLedger
): LandingStuckVerdict | null {
  const stuck = latestStuckLandingAttempt(snapshot, ledger)
  if (stuck === null) {
    return null
  }
  const deviation = objectiveLandingFailedDeviation({
    rung: stuck.action.rung,
    contentIdentity: stuck.action.contentIdentity,
    reason: stuck.reason
  })
  const ownerResolutionAtMs = latestOwnerResolutionAtMs(
    ledger,
    ownerDeviationEscalationId(ledger.watcherId, deviation)
  )
  const sinceMs = Math.max(
    stuck.attempt.atMs,
    stuck.resolutionAtMs ?? stuck.attempt.atMs,
    ownerResolutionAtMs ?? stuck.attempt.atMs
  )
  const elapsedMs = snapshot.observedAtMs - sinceMs
  if (elapsedMs < OBJECTIVE_LANDING_STUCK_WINDOW_MS) {
    return null
  }
  const elapsedMinutes = Math.floor(elapsedMs / 60_000)
  const lastReason = stuck.reason || 'unknown'
  return {
    deviation,
    reason: `landing ${stuck.action.kind} ${stuck.disposition} for ${elapsedMinutes} min (last: ${lastReason})`,
    detail: stuck.action.contentIdentity
  }
}

export const objectiveLandingStuckPredicate: StopPredicate<ObjectiveWorld> = {
  id: OBJECTIVE_LANDING_STUCK_PREDICATE_ID,
  disposition: 'park',
  evaluate(snapshot, ledger) {
    const verdict = landingStuckVerdict(snapshot, ledger)
    return verdict === null
      ? { stop: false }
      : { stop: true, reason: verdict.reason, detail: verdict.detail }
  },
  deviationForFiring(_verdict, snapshot, ledger) {
    const verdict = landingStuckVerdict(snapshot, ledger)
    if (verdict === null) {
      throw new Error('Landing-stuck predicate fired without a stuck landing attempt')
    }
    return verdict.deviation
  }
}
