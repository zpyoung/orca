import {
  createReportValidationProvenance,
  ReportValidationProvenanceSchema,
  type ObjectiveFailureClass,
  type ReportValidationProvenance
} from '../fork-heimdall/effect-certainty'
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
  | 'plan-off-without-usable-plan'
  | 'projection-refresh-pending'
  | 'node-in-flight'
  | 'node-retry-exhausted'
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

/** Bounds a node's silent auto-redispatch loop; past this it must park rather than retry again. */
export const OBJECTIVE_INFRA_REDISPATCH_CAP = 2
export type ObjectiveRetryableFailureClass = Extract<ObjectiveFailureClass, 'infra' | 'environment'>

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

export function objectiveAttemptFailureClass(
  attempt: AttemptEntry,
  ledger: WatcherLedger
): ObjectiveFailureClass | undefined {
  const resolution = getAttemptResolution(ledger, attempt.attemptId)
  return resolution ? resolution.failureClass : attempt.failureClass
}

export function objectiveAttemptReportValidation(
  attempt: AttemptEntry,
  ledger: WatcherLedger
): ReportValidationProvenance | null {
  const resolution = getAttemptResolution(ledger, attempt.attemptId)
  if (resolution?.reportValidation) {
    return resolution.reportValidation
  }
  const result =
    attempt.result !== null && typeof attempt.result === 'object'
      ? (attempt.result as Record<string, unknown>)
      : null
  const parsed = ReportValidationProvenanceSchema.safeParse(result?.reportValidation)
  return parsed.success ? parsed.data : null
}

export function objectiveReportValidationDetail(provenance: ReportValidationProvenance): string {
  const sourceCode =
    provenance.sourceCode === undefined ? '' : `; sourceCode=${provenance.sourceCode}`
  const classification = `report ${provenance.status}: ${provenance.code}${sourceCode}; role=${provenance.role}; hostVerifiable=${String(provenance.hostVerifiable)}`
  return provenance.detail ? `${classification}\n${provenance.detail}` : classification
}

/**
 * Null covers every non-retryable outcome (criteria, unclassified, still landed) by construction,
 * so a future retryable class has to be added here rather than by relaxing a caller's conditional.
 */
export function objectiveRetryableFailure(
  attempt: AttemptEntry,
  ledger: WatcherLedger
): ObjectiveRetryableFailureClass | null {
  if (objectiveAttemptDisposition(attempt, ledger) !== 'not-landed') {
    return null
  }
  const failureClass = objectiveAttemptFailureClass(attempt, ledger)
  return failureClass === 'infra' || failureClass === 'environment' ? failureClass : null
}

/**
 * Counts only redispatches (retryOf set), not the original dispatch, so the first retry is r0 and
 * this doubles as both the next ordinal and the exhaustion threshold for the same node.
 */
export function objectiveNodeRetryCount(
  attempts: readonly ObjectiveAttempt[],
  revisionId: string,
  taskKey: string
): number {
  let count = 0
  for (const { action } of attempts) {
    if (
      action.kind === 'dispatch-node' &&
      action.revisionId === revisionId &&
      action.taskKey === taskKey &&
      action.retryOf !== undefined
    ) {
      count += 1
    }
  }
  return count
}

/**
 * Task keys whose latest dispatch-node attempt in this revision is still unsettled. A plan row only
 * ever records a *successful* dispatch (`plan_node.dispatch_id`), so this is the one place that can
 * tell an in-flight node from a failed one — both have no dispatch row, but only the former is
 * actively running work an amendment must not silently drop.
 */
export function objectiveInFlightTaskKeys(ledger: WatcherLedger, revisionId: string): Set<string> {
  const inFlight = new Set<string>()
  for (const { action, attempt } of objectiveAttempts(ledger)) {
    if (action.kind !== 'dispatch-node' || action.revisionId !== revisionId) {
      continue
    }
    const disposition = objectiveAttemptDisposition(attempt, ledger)
    if (disposition === 'in-flight' || disposition === 'indeterminate') {
      inFlight.add(action.taskKey)
    } else {
      inFlight.delete(action.taskKey)
    }
  }
  return inFlight
}

/** The fingerprint the original (non-retry) dispatch captured its workspace baseline under. */
export function objectiveOriginalDispatchFingerprint(
  ledger: WatcherLedger,
  retryOf: string
): string | null {
  for (const attempt of getLatestAttempts(ledger)) {
    const action = ObjectiveActionSchema.safeParse(attempt.action)
    if (
      action.success &&
      action.data.kind === 'dispatch-node' &&
      action.data.evidenceKey === retryOf
    ) {
      return attempt.fingerprint
    }
  }
  return null
}

/**
 * A retry's `retryOf` names an evidenceKey that must already be in this append-only ledger; a miss
 * means that invariant broke, so this throws instead of silently keying the baseline to the retry's
 * own fingerprint, which would salvage nothing while looking like it validated the retry's report.
 */
export function requireObjectiveOriginalDispatchFingerprint(
  ledger: WatcherLedger,
  retryOf: string
): string {
  const fingerprint = objectiveOriginalDispatchFingerprint(ledger, retryOf)
  if (fingerprint === null) {
    throw new Error(`Objective retry's original dispatch is missing from the ledger: ${retryOf}`)
  }
  return fingerprint
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

const MAILBOX_SUBJECT_MAX_CHARS = 2_048
const MAILBOX_BODY_MAX_CHARS = 8_192

function mailboxPayload(value: unknown): {
  type: string
  payload: Record<string, unknown>
  subject?: string
  body?: string
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
  // truncated here, not left to the schema's max(), so an oversized field can't drop the whole report
  const subject =
    typeof record.subject === 'string' && record.subject.length > 0
      ? record.subject.slice(0, MAILBOX_SUBJECT_MAX_CHARS)
      : undefined
  const body =
    typeof record.body === 'string' && record.body.length > 0
      ? record.body.slice(0, MAILBOX_BODY_MAX_CHARS)
      : undefined
  return {
    type: record.type,
    payload: record.payload as Record<string, unknown>,
    ...(subject === undefined ? {} : { subject }),
    ...(body === undefined ? {} : { body })
  }
}

function projectedReportRejection(args: {
  action: Extract<ObjectiveAction, { kind: `dispatch-${string}` }>
  dispatchId: string
  reportPath: string | null
  filesModified: readonly string[]
  value: unknown
}): ReportValidationProvenance | null {
  if (args.value === undefined) {
    return null
  }
  const record =
    typeof args.value === 'object' && args.value !== null && !Array.isArray(args.value)
      ? (args.value as Record<string, unknown>)
      : null
  const sourceCode =
    record !== null && typeof record.code === 'string' && record.code.trim().length > 0
      ? record.code
      : 'malformed-report-rejection-evidence'
  const detail =
    record !== null && typeof record.reason === 'string' && record.reason.trim().length > 0
      ? record.reason
      : 'Worker completion carried malformed report-rejection evidence'
  const role =
    args.action.kind === 'dispatch-planner'
      ? 'planner'
      : args.action.kind === 'dispatch-node'
        ? 'implementer'
        : args.action.kind === 'dispatch-reviewer'
          ? 'reviewer'
          : 'integrator'
  return createReportValidationProvenance({
    status: 'rejected',
    code: 'semantic-invalid',
    sourceCode,
    role,
    dispatchId: args.dispatchId,
    ...(args.action.kind === 'dispatch-node' ? { taskKey: args.action.taskKey } : {}),
    reportPath: args.reportPath,
    detail,
    reportedFiles: args.filesModified,
    hostVerifiable: true
  })
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
    const parsedFiles = Object.hasOwn(message.payload, 'filesModified')
      ? ObjectivePendingReportSchema.shape.filesModified.safeParse(message.payload.filesModified)
      : null
    const filesModified = parsedFiles?.success ? parsedFiles.data : []
    const reportPath =
      typeof message.payload.reportPath === 'string' ? message.payload.reportPath : null
    const reportValidation = projectedReportRejection({
      action,
      dispatchId,
      reportPath,
      filesModified,
      value: message.payload.reportRejection
    })
    const report = ObjectivePendingReportSchema.safeParse({
      dispatchId,
      actionKind: action.kind,
      outcome,
      reportPath,
      filesModified,
      ...(parsedFiles !== null &&
      !parsedFiles.success &&
      message.payload.reportRejection === undefined
        ? { evidenceIssue: 'files-modified-malformed' as const }
        : {}),
      ...(reportValidation === null ? {} : { reportValidation }),
      orchestrationTaskId: orchestrationTaskByDispatch.get(dispatchId) ?? null,
      taskKey: action.kind === 'dispatch-node' ? action.taskKey : null,
      dispatchedContentIdentity: action.contentIdentity,
      atMs: entry.atMs,
      ...(message.subject === undefined ? {} : { subject: message.subject }),
      ...(message.body === undefined ? {} : { body: message.body })
    })
    if (report.success) {
      byDispatch.set(dispatchId, report.data)
    }
  }
  return [...byDispatch.values()].sort((left, right) => left.atMs - right.atMs)
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
    const reportValidation = objectiveAttemptReportValidation(planner.attempt, ledger)
    if (
      report?.outcome === 'succeeded' &&
      report.reportPath !== null &&
      report.evidenceIssue === undefined &&
      report.reportValidation === undefined &&
      reportValidation === null
    ) {
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
