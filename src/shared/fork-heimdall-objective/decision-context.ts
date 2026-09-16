import type { DecisionOutcome } from '../fork-heimdall/kind-contract'
import { getAttemptResolution, getLatestAttempts } from '../fork-heimdall/ledger-queries'
import type { AttemptEntry, WatcherLedger } from '../fork-heimdall/ledger-types'
import type { Snapshot } from '../fork-heimdall/snapshot'
import {
  ObjectiveActionSchema,
  type ObjectiveAction,
  type DispatchPlannerAction
} from './objective-actions'
import {
  ObjectivePendingReportSchema,
  type ObjectivePendingReport,
  type ObjectiveRevisionProjection,
  type ObjectiveWorld
} from './detail-types'

export type ObjectiveNoActionReason =
  | 'planner-in-flight'
  | 'plan-ingestion-in-flight'
  | 'plan-activation-in-flight'
  | 'projection-refresh-pending'
  | 'node-in-flight'
  | 'dependency-task-id-unavailable'
  | 'nodes-blocked-by-dependencies'
  | 'check-in-flight'
  | 'review-in-flight'
  | 'review-report-unavailable'
  | 'landing-in-flight'
  | 'landed-at-bar'
  | 'branch-not-attached'
  | 'push-target-unavailable'
  | 'base-branch-unresolvable'

export type ObjectiveDecisionOutcome = DecisionOutcome<ObjectiveAction>
export type ObjectiveAttempt = { attempt: AttemptEntry; action: ObjectiveAction }
export type AttemptDisposition = 'in-flight' | 'landed' | 'not-landed' | 'indeterminate'

export function objectiveNoAction(
  phase: string,
  reason: ObjectiveNoActionReason,
  detail?: string
): ObjectiveDecisionOutcome {
  return {
    action: null,
    reason,
    ...(detail === undefined ? {} : { detail }),
    considered: [{ phase, reason, ...(detail === undefined ? {} : { detail }) }]
  }
}

export function objectiveAttempts(ledger: WatcherLedger): ObjectiveAttempt[] {
  const attempts: ObjectiveAttempt[] = []
  for (const attempt of getLatestAttempts(ledger)) {
    const action = ObjectiveActionSchema.safeParse(attempt.action)
    if (action.success) {
      attempts.push({ attempt, action: action.data })
    }
  }
  return attempts
}

export function objectiveAttemptDisposition(
  attempt: AttemptEntry,
  ledger: WatcherLedger
): AttemptDisposition {
  const resolution = getAttemptResolution(ledger, attempt.attemptId)
  if (resolution) {
    return resolution.effect
  }
  if (attempt.state === 'attempted' || attempt.state === 'running') {
    return 'in-flight'
  }
  return attempt.effect ?? 'indeterminate'
}

export function latestObjectiveAttempt(
  attempts: readonly ObjectiveAttempt[],
  predicate: (action: ObjectiveAction) => boolean
): ObjectiveAttempt | null {
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    if (predicate(attempts[index].action)) {
      return attempts[index]
    }
  }
  return null
}

function mailboxPayload(value: unknown): {
  type: string
  payload: Record<string, unknown>
} | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  if (
    typeof record.type !== 'string' ||
    typeof record.payload !== 'object' ||
    record.payload === null ||
    Array.isArray(record.payload)
  ) {
    return null
  }
  return { type: record.type, payload: record.payload as Record<string, unknown> }
}

export function projectObjectiveReports(ledger: WatcherLedger): ObjectivePendingReport[] {
  const dispatchById = new Map<string, ObjectiveAttempt>()
  for (const objectiveAttempt of objectiveAttempts(ledger)) {
    if (
      objectiveAttempt.action.kind.startsWith('dispatch-') &&
      objectiveAttempt.attempt.dispatchId !== undefined
    ) {
      dispatchById.set(objectiveAttempt.attempt.dispatchId, objectiveAttempt)
    }
  }
  const orchestrationTaskByDispatch = new Map<string, string>()
  for (const entry of ledger.entries) {
    if (entry.kind !== 'evidence' || entry.evidenceKind !== 'orchestration-mailbox') {
      continue
    }
    const message = mailboxPayload(entry.payload)
    const dispatchId = message?.payload.dispatchId
    const taskId = message?.payload.taskId
    if (
      typeof dispatchId === 'string' &&
      typeof taskId === 'string' &&
      !orchestrationTaskByDispatch.has(dispatchId)
    ) {
      orchestrationTaskByDispatch.set(dispatchId, taskId)
    }
  }

  const byDispatch = new Map<string, ObjectivePendingReport>()
  for (const entry of ledger.entries) {
    if (entry.kind !== 'evidence' || entry.evidenceKind !== 'orchestration-mailbox') {
      continue
    }
    const message = mailboxPayload(entry.payload)
    if (message?.type !== 'worker_done') {
      continue
    }
    const dispatchId = message.payload.dispatchId
    const outcome = message.payload.outcome
    if (typeof dispatchId !== 'string' || (outcome !== 'succeeded' && outcome !== 'failed')) {
      continue
    }
    const dispatched = dispatchById.get(dispatchId)
    if (!dispatched || !dispatched.action.kind.startsWith('dispatch-')) {
      continue
    }
    const action = dispatched.action
    if (
      action.kind !== 'dispatch-planner' &&
      action.kind !== 'dispatch-node' &&
      action.kind !== 'dispatch-reviewer' &&
      action.kind !== 'dispatch-integrator'
    ) {
      continue
    }
    const filesModified = Array.isArray(message.payload.filesModified)
      ? message.payload.filesModified.filter((file): file is string => typeof file === 'string')
      : []
    const report = ObjectivePendingReportSchema.safeParse({
      dispatchId,
      actionKind: action.kind,
      outcome,
      reportPath:
        typeof message.payload.reportPath === 'string' ? message.payload.reportPath : null,
      filesModified,
      orchestrationTaskId: orchestrationTaskByDispatch.get(dispatchId) ?? null,
      taskKey: action.kind === 'dispatch-node' ? action.taskKey : null,
      dispatchedContentIdentity: action.contentIdentity,
      atMs: entry.atMs
    })
    if (report.success) {
      byDispatch.set(dispatchId, report.data)
    }
  }
  return [...byDispatch.values()]
}

export function activeObjectiveRevision(world: ObjectiveWorld): ObjectiveRevisionProjection | null {
  return (
    world.plan.revisions
      .filter((revision) => revision.status === 'approved')
      .sort((left, right) => right.number - left.number)[0] ?? null
  )
}

function highestRevisionNumber(
  world: ObjectiveWorld,
  attempts: readonly ObjectiveAttempt[]
): number {
  let highest = world.plan.revisions.reduce(
    (maximum, revision) => Math.max(maximum, revision.number),
    0
  )
  for (const { action } of attempts) {
    if (action.kind === 'dispatch-planner') {
      highest = Math.max(highest, action.revisionNumber)
    }
  }
  return highest
}

export function decidePlannerAction(
  snapshot: Snapshot<ObjectiveWorld>,
  ledger: WatcherLedger,
  attempts: readonly ObjectiveAttempt[],
  reports: readonly ObjectivePendingReport[],
  reason: DispatchPlannerAction['reason'],
  afterRevisionNumber: number
): ObjectiveDecisionOutcome {
  const planner = latestObjectiveAttempt(
    attempts,
    (action) => action.kind === 'dispatch-planner' && action.revisionNumber > afterRevisionNumber
  )
  if (planner?.action.kind === 'dispatch-planner') {
    const disposition = objectiveAttemptDisposition(planner.attempt, ledger)
    const report = reports.find((candidate) => candidate.dispatchId === planner.attempt.dispatchId)
    if (report?.outcome === 'succeeded' && report.reportPath !== null) {
      const ingestion = latestObjectiveAttempt(
        attempts,
        (action) => action.kind === 'ingest-plan' && action.dispatchId === report.dispatchId
      )
      if (ingestion) {
        const ingestionDisposition = objectiveAttemptDisposition(ingestion.attempt, ledger)
        if (ingestionDisposition === 'in-flight' || ingestionDisposition === 'indeterminate') {
          return objectiveNoAction('plan', 'plan-ingestion-in-flight', report.dispatchId)
        }
        if (ingestionDisposition === 'landed') {
          return objectiveNoAction('plan', 'projection-refresh-pending', report.dispatchId)
        }
      } else {
        return {
          action: {
            kind: 'ingest-plan',
            capability: 'plan',
            visibility: 'local',
            recovery: 'replay-safe',
            contentIdentity: snapshot.contentIdentity,
            evidenceKey: report.dispatchId,
            dispatchId: report.dispatchId,
            revisionNumber: planner.action.revisionNumber,
            reportPath: report.reportPath
          }
        }
      }
    }
    if (disposition === 'in-flight' || disposition === 'indeterminate') {
      return objectiveNoAction('plan', 'planner-in-flight', planner.action.evidenceKey)
    }
  }

  const revisionNumber = highestRevisionNumber(snapshot.world, attempts) + 1
  return {
    action: {
      kind: 'dispatch-planner',
      capability: 'plan',
      visibility: 'local',
      contentIdentity: snapshot.contentIdentity,
      evidenceKey: `plan:${revisionNumber}`,
      revisionNumber,
      reason: revisionNumber === 1 ? 'initial' : reason
    }
  }
}
