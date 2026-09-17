import type { StopPredicate } from '../fork-heimdall/stop-policy'
import { getAttemptResolution, getLatestAttempts } from '../fork-heimdall/ledger-queries'
import type { WatcherLedger } from '../fork-heimdall/ledger-types'
import { stopPredicateParkEscalationId } from '../fork-heimdall/park-escalation-id'
import { ObjectiveActionResultSchema, ObjectiveActionSchema } from './objective-actions'
import type { ObjectiveLandingBar } from './contract-types'
import type { ObjectiveWorld } from './detail-types'
import { OBJECTIVE_LANDING_LADDER, reachedRungs, stopRungForBar } from './landing-ladder'

export const OBJECTIVE_BAR_REACHED_PREDICATE_ID = 'objective-bar-reached'
export const OBJECTIVE_WORKER_ESCALATION_PREDICATE_ID = 'worker-escalation'

function landedRungIdentityFromAttempts(
  snapshot: { contentIdentity: string; world: ObjectiveWorld },
  ledger: WatcherLedger,
  stopRung: ObjectiveLandingBar
): string | null {
  let activeRevisionId: string | null = null
  let activeRevisionNumber = -1
  for (const revision of snapshot.world.plan.revisions) {
    if (revision.status === 'approved' && revision.number > activeRevisionNumber) {
      activeRevisionId = revision.id
      activeRevisionNumber = revision.number
    }
  }
  if (activeRevisionId === null) {
    return null
  }

  const attempts = getLatestAttempts(ledger)
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const attempt = attempts[index]
    if ((getAttemptResolution(ledger, attempt.attemptId)?.effect ?? attempt.effect) !== 'landed') {
      continue
    }
    const parsedAction = ObjectiveActionSchema.safeParse(attempt.action)
    if (
      !parsedAction.success ||
      (parsedAction.data.kind !== 'record-landing' &&
        parsedAction.data.kind !== 'commit-local-branch' &&
        parsedAction.data.kind !== 'push-ref' &&
        parsedAction.data.kind !== 'open-hosted-review') ||
      parsedAction.data.revisionId !== activeRevisionId ||
      parsedAction.data.contentIdentity !== snapshot.contentIdentity ||
      OBJECTIVE_LANDING_LADDER.indexOf(parsedAction.data.rung) <
        OBJECTIVE_LANDING_LADDER.indexOf(stopRung)
    ) {
      continue
    }
    const action = parsedAction.data
    const parsedResult = ObjectiveActionResultSchema.safeParse(attempt.result)
    if (!parsedResult.success) {
      continue
    }
    const result = parsedResult.data
    if (
      action.kind === 'record-landing' &&
      result.kind === 'landing-recorded' &&
      result.naturalKey.kind === 'landing-evidence' &&
      result.naturalKey.rung === action.rung &&
      result.naturalKey.contentIdentity === action.contentIdentity
    ) {
      return action.contentIdentity
    }
    if (
      action.kind === 'commit-local-branch' &&
      result.kind === 'commit-recorded' &&
      result.naturalKey.kind === 'commit-local-branch' &&
      result.naturalKey.revisionId === action.revisionId &&
      result.naturalKey.fromContentIdentity === action.fromContentIdentity
    ) {
      return result.contentIdentity
    }
    if (
      action.kind === 'push-ref' &&
      result.kind === 'push-recorded' &&
      result.naturalKey.kind === 'push-ref' &&
      result.naturalKey.commitSha === action.commitSha &&
      result.naturalKey.remote === action.remote &&
      result.naturalKey.branch === action.branch
    ) {
      return action.contentIdentity
    }
    if (
      action.kind === 'open-hosted-review' &&
      result.kind === 'review-recorded' &&
      result.naturalKey.kind === 'open-hosted-review' &&
      result.naturalKey.provider === action.provider &&
      result.naturalKey.branch === action.branch &&
      result.naturalKey.headSha === action.headSha
    ) {
      return action.contentIdentity
    }
  }
  return null
}

export const objectiveBarReachedPredicate: StopPredicate<ObjectiveWorld> = {
  id: OBJECTIVE_BAR_REACHED_PREDICATE_ID,
  disposition: 'terminal',
  evaluate(snapshot, ledger) {
    const bar = snapshot.world.contract.landingBar
    const stopRung = stopRungForBar(bar)
    const projected = reachedRungs(snapshot.world.plan.landing, snapshot.contentIdentity).has(
      stopRung
    )
    const reachedIdentity = projected
      ? snapshot.contentIdentity
      : landedRungIdentityFromAttempts(snapshot, ledger, stopRung)
    if (reachedIdentity === null) {
      return { stop: false }
    }
    return {
      stop: true,
      reason:
        bar === 'merged'
          ? 'hosted-review rung reached; handed off'
          : `${stopRung} landing bar reached`,
      detail: reachedIdentity
    }
  }
}

function latestWorkerEscalationAcknowledgementIndex(ledger: WatcherLedger): number {
  for (let index = ledger.entries.length - 1; index >= 0; index -= 1) {
    const entry = ledger.entries[index]
    if (
      entry.kind === 'escalation' &&
      entry.escalationId ===
        stopPredicateParkEscalationId(ledger.watcherId, OBJECTIVE_WORKER_ESCALATION_PREDICATE_ID) &&
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
  objectiveWorkerEscalationPredicate
] as const satisfies readonly StopPredicate<ObjectiveWorld>[]
