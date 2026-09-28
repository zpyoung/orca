import type { StopPredicate } from '../fork-heimdall/stop-policy'
import { getAttemptResolution, getLatestAttempts } from '../fork-heimdall/ledger-queries'
import type { WatcherLedger } from '../fork-heimdall/ledger-types'
import type { Snapshot } from '../fork-heimdall/snapshot'
import {
  WORKER_ESCALATION_CONSUMED_EVIDENCE_KIND,
  workerEscalationConsumedMessageId
} from '../fork-heimdall/worker-escalation-consumption'
import { ObjectiveActionResultSchema } from './objective-action-results'
import { ObjectiveActionSchema } from './objective-actions'
import type { ObjectiveLandingBar } from './contract-types'
import {
  activeObjectiveRevision,
  latestObjectiveAttempt,
  objectiveAttemptDisposition,
  objectiveAttempts,
  objectiveInFlightTaskKeys,
  objectiveNodeRetryCount,
  objectiveRetryableFailure,
  projectObjectiveReports,
  OBJECTIVE_INFRA_REDISPATCH_CAP
} from './decision-context'
import { objectiveRetryExhaustedDeviation } from './deviation-context'
import type { ObjectiveWorld } from './detail-types'
import { OBJECTIVE_LANDING_LADDER, reachedRungs, stopRungForBar } from './landing-ladder'
import { prioritizeReadyObjectiveTaskKeys } from './parallel-scheduling'
import { objectiveLandingStuckPredicate } from './landing-stuck-policy'

export const OBJECTIVE_BAR_REACHED_PREDICATE_ID = 'objective-bar-reached'
export const OBJECTIVE_WORKER_ESCALATION_PREDICATE_ID = 'worker-escalation'
export const OBJECTIVE_INFRA_RETRY_EXHAUSTED_PREDICATE_ID = 'objective-infra-retry-exhausted'

/**
 * Budget exhaustion stops admission, not work already accepted. The generic runner consults this
 * hook before parking so worker completions, durable report ingestion, and the merge train drain.
 */
export function objectiveHasPendingDrain(
  snapshot: Snapshot<ObjectiveWorld>,
  ledger: WatcherLedger
): boolean {
  const attempts = objectiveAttempts(ledger)
  for (const { action, attempt } of attempts) {
    if (
      action.kind.startsWith('dispatch-') &&
      (objectiveAttemptDisposition(attempt, ledger) === 'in-flight' ||
        objectiveAttemptDisposition(attempt, ledger) === 'indeterminate')
    ) {
      return true
    }
  }
  if (
    snapshot.world.parallel?.dispatches.some(
      (dispatch) =>
        dispatch.state === 'running' ||
        dispatch.state === 'waiting-to-apply' ||
        dispatch.state === 'applying' ||
        dispatch.state === 'resolving-conflict'
    )
  ) {
    return true
  }
  for (const report of projectObjectiveReports(ledger)) {
    if (report.outcome !== 'succeeded' || report.reportPath === null) {
      continue
    }
    const ingestion = latestObjectiveAttempt(attempts, (action) => {
      if (report.actionKind === 'dispatch-node') {
        return action.kind === 'ingest-report' && action.dispatchId === report.dispatchId
      }
      if (report.actionKind === 'dispatch-planner') {
        return action.kind === 'ingest-plan' && action.dispatchId === report.dispatchId
      }
      return action.kind === 'ingest-verdict' && action.dispatchId === report.dispatchId
    })
    if (!ingestion) {
      return true
    }
    const disposition = objectiveAttemptDisposition(ingestion.attempt, ledger)
    if (disposition === 'in-flight' || disposition === 'indeterminate') {
      return true
    }
  }
  return false
}

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

function consumedWorkerEscalationMessageIds(ledger: WatcherLedger): ReadonlySet<string> {
  const consumed = new Set<string>()
  for (const entry of ledger.entries) {
    if (
      entry.kind !== 'evidence' ||
      entry.evidenceKind !== WORKER_ESCALATION_CONSUMED_EVIDENCE_KIND
    ) {
      continue
    }
    const messageId = workerEscalationConsumedMessageId(entry.payload)
    if (messageId) {
      consumed.add(messageId)
    }
  }
  return consumed
}

type WorkerEscalationMessage = { reason: string; detail?: string; dispatchId?: string }

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function escalationMessage(value: unknown): WorkerEscalationMessage | null {
  if (!isPlainRecord(value)) {
    return null
  }
  const record = value
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
  const payload = isPlainRecord(record.payload) ? record.payload : null
  const dispatchId = typeof payload?.dispatchId === 'string' ? payload.dispatchId : undefined
  return {
    reason: subject,
    ...(body === undefined ? {} : { detail: body }),
    ...(dispatchId === undefined ? {} : { dispatchId })
  }
}

function latestWorkerEscalationMessage(
  ledger: WatcherLedger
): { message: WorkerEscalationMessage; messageId?: string } | null {
  for (let index = ledger.entries.length - 1; index >= 0; index -= 1) {
    const entry = ledger.entries[index]
    if (entry.kind !== 'evidence' || entry.evidenceKind !== 'orchestration-mailbox') {
      continue
    }
    const message = escalationMessage(entry.payload)
    if (message) {
      return { message, messageId: entry.source?.messageId }
    }
  }
  return null
}

export const objectiveWorkerEscalationPredicate: StopPredicate<ObjectiveWorld> = {
  id: OBJECTIVE_WORKER_ESCALATION_PREDICATE_ID,
  evaluate(snapshot, ledger) {
    const latest = latestWorkerEscalationMessage(ledger)
    if (!latest) {
      return { stop: false }
    }
    if (
      latest.message.dispatchId !== undefined &&
      snapshot.world.parallel?.dispatches.some(
        (dispatch) => dispatch.dispatchId === latest.message.dispatchId
      )
    ) {
      return { stop: false }
    }
    const messageId = latest.messageId
    const consumed =
      messageId !== undefined && consumedWorkerEscalationMessageIds(ledger).has(messageId)
    // a message with no id can never be marked consumed, so it always fires rather than wedge shut
    if (consumed) {
      return { stop: false }
    }
    return {
      stop: true,
      reason: latest.message.reason,
      ...(latest.messageId === undefined ? {} : { detail: latest.messageId })
    }
  }
}

/** Parks rather than replans: an infra/environment death is not a plan defect. */
function retryConflictContext(
  world: ObjectiveWorld,
  revisionId: string,
  taskKey: string
): { conflictPaths: string[]; conflictingDispatchIds: string[] } | null {
  const resolving = world.parallel?.dispatches.find(
    (dispatch) =>
      dispatch.revisionId === revisionId &&
      dispatch.taskKey === taskKey &&
      dispatch.state === 'resolving-conflict'
  )
  if (!resolving) {
    return null
  }
  const dispatchIds = [resolving.dispatchId, ...resolving.conflictingDispatchIds].filter(
    (dispatchId): dispatchId is string => dispatchId !== null
  )
  return {
    conflictPaths: resolving.conflictPaths,
    conflictingDispatchIds: [...new Set(dispatchIds)]
  }
}

export const objectiveInfraRetryExhaustedPredicate: StopPredicate<ObjectiveWorld> = {
  id: OBJECTIVE_INFRA_RETRY_EXHAUSTED_PREDICATE_ID,
  disposition: 'park',
  evaluate(snapshot, ledger) {
    const revision = activeObjectiveRevision(snapshot.world)
    if (!revision) {
      return { stop: false }
    }
    const attempts = objectiveAttempts(ledger)
    for (const node of snapshot.world.plan.nodes) {
      if (node.revisionId !== revision.id) {
        continue
      }
      const dispatch = latestObjectiveAttempt(
        attempts,
        (action) =>
          action.kind === 'dispatch-node' &&
          action.revisionId === revision.id &&
          action.taskKey === node.taskKey
      )
      if (!dispatch || objectiveAttemptDisposition(dispatch.attempt, ledger) !== 'not-landed') {
        continue
      }
      const retryable = objectiveRetryableFailure(dispatch.attempt, ledger)
      const conflict = retryConflictContext(snapshot.world, revision.id, node.taskKey)
      if (retryable === null && conflict === null) {
        continue
      }
      const retryCount = objectiveNodeRetryCount(attempts, revision.id, node.taskKey)
      if (retryCount < OBJECTIVE_INFRA_REDISPATCH_CAP) {
        continue
      }
      const parallelRun =
        (snapshot.world.parallel?.effectiveMaxConcurrency ?? 1) > 1 ||
        (snapshot.world.parallel?.dispatches.length ?? 0) > 0
      if (parallelRun) {
        const activeSibling = snapshot.world.parallel?.dispatches.some(
          (dispatch) =>
            dispatch.revisionId === revision.id &&
            dispatch.taskKey !== node.taskKey &&
            (dispatch.state === 'running' ||
              dispatch.state === 'waiting-to-apply' ||
              dispatch.state === 'applying' ||
              dispatch.state === 'resolving-conflict')
        )
        const unavailable = objectiveInFlightTaskKeys(ledger, revision.id)
        unavailable.add(node.taskKey)
        const readySibling = prioritizeReadyObjectiveTaskKeys(
          snapshot.world.plan.nodes.filter((candidate) => candidate.revisionId === revision.id),
          unavailable
        ).length
        if (activeSibling || readySibling > 0) {
          continue
        }
      }
      const conflictReason =
        conflict === null
          ? ''
          : `; conflict paths: ${conflict.conflictPaths.join(', ') || 'none'}; dispatches: ${conflict.conflictingDispatchIds.join(', ') || 'none'}`
      const retryLabel = conflict === null ? 'infra/environment redispatches' : 'redispatches'
      return {
        stop: true,
        reason: `${node.taskKey} exhausted ${OBJECTIVE_INFRA_REDISPATCH_CAP} ${retryLabel} (last: ${retryable ?? 'conflict-resolution'})${conflictReason}`,
        detail: node.taskKey
      }
    }
    return { stop: false }
  },
  deviationForFiring(verdict, snapshot, ledger) {
    const taskKey = verdict.detail ?? 'unknown'
    const revision = activeObjectiveRevision(snapshot.world)
    const attempts = objectiveAttempts(ledger)
    const dispatch = revision
      ? latestObjectiveAttempt(
          attempts,
          (action) =>
            action.kind === 'dispatch-node' &&
            action.revisionId === revision.id &&
            action.taskKey === taskKey
        )
      : null
    const conflict =
      revision === null ? null : retryConflictContext(snapshot.world, revision.id, taskKey)
    return objectiveRetryExhaustedDeviation({
      taskKey,
      retryCount: revision
        ? objectiveNodeRetryCount(attempts, revision.id, taskKey)
        : OBJECTIVE_INFRA_REDISPATCH_CAP,
      lastFailureClass: dispatch ? objectiveRetryableFailure(dispatch.attempt, ledger) : null,
      ...(conflict === null ? {} : conflict)
    })
  }
}

export const OBJECTIVE_STOP_PREDICATES = [
  objectiveBarReachedPredicate,
  objectiveWorkerEscalationPredicate,
  objectiveInfraRetryExhaustedPredicate,
  objectiveLandingStuckPredicate
] as const satisfies readonly StopPredicate<ObjectiveWorld>[]
