import type { StopPredicate } from '../fork-heimdall/stop-policy'
import { getAttemptResolution, getLatestAttempts } from '../fork-heimdall/ledger-queries'
import type { WatcherLedger } from '../fork-heimdall/ledger-types'
import { ObjectiveActionSchema } from './objective-actions'
import type { ObjectiveWorld } from './detail-types'

export const OBJECTIVE_BAR_REACHED_PREDICATE_ID = 'objective-bar-reached'
export const OBJECTIVE_AWAITING_PHASE_FOUR_PREDICATE_ID = 'objective-awaiting-phase-4'
export const OBJECTIVE_WORKER_ESCALATION_PREDICATE_ID = 'worker-escalation'

function filesOnDiskLandedAtCurrentIdentity(
  snapshot: { contentIdentity: string; world: ObjectiveWorld },
  ledger: WatcherLedger
): boolean {
  if (
    snapshot.world.plan.landing.some(
      (entry) =>
        entry.rung === 'files-on-disk' && entry.contentIdentity === snapshot.contentIdentity
    )
  ) {
    return true
  }
  return getLatestAttempts(ledger).some((attempt) => {
    if (attempt.state !== 'settled') {
      return false
    }
    const action = ObjectiveActionSchema.safeParse(attempt.action)
    if (
      !action.success ||
      action.data.kind !== 'record-landing' ||
      action.data.rung !== 'files-on-disk' ||
      action.data.contentIdentity !== snapshot.contentIdentity
    ) {
      return false
    }
    return (getAttemptResolution(ledger, attempt.attemptId)?.effect ?? attempt.effect) === 'landed'
  })
}

export const objectiveBarReachedPredicate: StopPredicate<ObjectiveWorld> = {
  id: OBJECTIVE_BAR_REACHED_PREDICATE_ID,
  disposition: 'terminal',
  evaluate(snapshot, ledger) {
    if (
      snapshot.world.contract.landingBar !== 'files-on-disk' ||
      !filesOnDiskLandedAtCurrentIdentity(snapshot, ledger)
    ) {
      return { stop: false }
    }
    return {
      stop: true,
      reason: 'files-on-disk landing bar reached',
      detail: snapshot.contentIdentity
    }
  }
}

export const objectiveAwaitingPhaseFourPredicate: StopPredicate<ObjectiveWorld> = {
  id: OBJECTIVE_AWAITING_PHASE_FOUR_PREDICATE_ID,
  evaluate(snapshot, ledger) {
    if (
      snapshot.world.contract.landingBar === 'files-on-disk' ||
      !filesOnDiskLandedAtCurrentIdentity(snapshot, ledger)
    ) {
      return { stop: false }
    }
    return {
      stop: true,
      reason: `files-on-disk reached; awaiting Phase 4 for ${snapshot.world.contract.landingBar}`,
      detail: snapshot.world.contract.landingBar
    }
  }
}

function latestWorkerEscalationAcknowledgementIndex(ledger: WatcherLedger): number {
  for (let index = ledger.entries.length - 1; index >= 0; index -= 1) {
    const entry = ledger.entries[index]
    if (
      entry.kind === 'escalation' &&
      entry.escalationKind === `park-stop-predicate:${OBJECTIVE_WORKER_ESCALATION_PREDICATE_ID}` &&
      (entry.status === 'acknowledged' || entry.status === 'resolved')
    ) {
      return index
    }
  }
  return -1
}

type WorkerEscalationMessage = { reason: string; detail?: string }

function escalationMessage(value: unknown): WorkerEscalationMessage | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  if (record.type !== 'escalation') {
    return null
  }
  const subject =
    typeof record.subject === 'string' && record.subject.trim().length > 0
      ? record.subject.trim()
      : 'Worker requested escalation'
  const body =
    typeof record.body === 'string' && record.body.trim().length > 0
      ? record.body.trim()
      : undefined
  return body === undefined ? { reason: subject } : { reason: subject, detail: body }
}

export const objectiveWorkerEscalationPredicate: StopPredicate<ObjectiveWorld> = {
  id: OBJECTIVE_WORKER_ESCALATION_PREDICATE_ID,
  evaluate(_snapshot, ledger) {
    const acknowledgedIndex = latestWorkerEscalationAcknowledgementIndex(ledger)
    for (let index = ledger.entries.length - 1; index > acknowledgedIndex; index -= 1) {
      const entry = ledger.entries[index]
      if (entry.kind !== 'evidence' || entry.evidenceKind !== 'orchestration-mailbox') {
        continue
      }
      const message = escalationMessage(entry.payload)
      if (message) {
        const detail = message.detail ?? entry.source?.messageId
        return {
          stop: true,
          reason: message.reason,
          ...(detail === undefined ? {} : { detail })
        }
      }
    }
    return { stop: false }
  }
}

export const OBJECTIVE_STOP_PREDICATES = [
  objectiveBarReachedPredicate,
  objectiveAwaitingPhaseFourPredicate,
  objectiveWorkerEscalationPredicate
] as const satisfies readonly StopPredicate<ObjectiveWorld>[]
