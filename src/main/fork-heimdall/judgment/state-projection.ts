import type { WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import { latestActiveWorkerEscalation } from '../../../shared/fork-heimdall/judgment/worker-escalation-projection'

const VOLATILE_KEYS = new Set([
  'atMs',
  'createdAtMs',
  'approvedAtMs',
  'startedAtMs',
  'finishedAtMs',
  'observedAtMs',
  'timestamp',
  'sequence',
  'messageId',
  'deliveryId'
])

export type ProjectedItem = {
  key: string
  value: unknown
  atMs: number
  sourceIndex: number
}

export type AttemptItem = ProjectedItem & {
  value: Record<string, unknown>
  attemptId: string
  action: Record<string, unknown>
  subjectId: string
  completed: boolean
}

export type ReportItem = ProjectedItem & { subjectId: string }

export type LedgerProjection = {
  attempts: AttemptItem[]
  approvals: ProjectedItem[]
  escalations: (ProjectedItem & { status: string })[]
  latestEscalation: unknown | null
  reports: ReportItem[]
}

export type LedgerDropSelection = {
  attemptKeys: ReadonlySet<string>
  approvalKeys: ReadonlySet<string>
  escalationKeys: ReadonlySet<string>
  reportKeys: ReadonlySet<string>
}

export type JudgmentLedgerState = {
  attempts: unknown[]
  approvals: unknown[]
  escalations: unknown[]
  latestEscalation: unknown | null
  reports: unknown[]
}

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function sanitized(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitized)
  }
  if (value === null || typeof value !== 'object') {
    return value
  }
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value).sort(([left], [right]) =>
    compareCodeUnits(left, right)
  )) {
    if (!VOLATILE_KEYS.has(key) && child !== undefined) {
      output[key] = sanitized(child)
    }
  }
  return output
}

export function stableJson(value: unknown): string {
  const serialized = JSON.stringify(sanitized(value))
  if (serialized === undefined) {
    throw new Error('Judgment state is not serializable')
  }
  return serialized
}

export function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === 'string' ? value[key] : undefined
}

export function numberField(value: Record<string, unknown>, key: string): number | undefined {
  return typeof value[key] === 'number' ? value[key] : undefined
}

function workerDoneReport(
  payload: unknown,
  subjectId: string
): { key: string; subjectId: string; report: unknown } | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return null
  }
  const message = payload as Record<string, unknown>
  if (message.type !== 'worker_done') {
    return null
  }
  const body =
    message.payload !== null &&
    typeof message.payload === 'object' &&
    !Array.isArray(message.payload)
      ? (message.payload as Record<string, unknown>)
      : {}
  const dispatchSubject =
    typeof body.dispatchId === 'string'
      ? body.dispatchId
      : typeof body.taskId === 'string'
        ? body.taskId
        : subjectId
  return {
    key: `worker_done:${dispatchSubject}`,
    subjectId: dispatchSubject,
    report: sanitized({
      type: 'worker_done',
      subject: message.subject,
      body: message.body,
      payload: body
    })
  }
}

function semanticAction(action: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    'kind',
    'capability',
    'contentIdentity',
    'evidenceKey',
    'retryOf',
    'revisionId',
    'revisionNumber',
    'taskKey',
    'dispatchId',
    'criterionId',
    'role',
    'rung'
  ] as const
  return sanitized(
    Object.fromEntries(
      keys.flatMap((key) => (action[key] === undefined ? [] : [[key, action[key]]]))
    )
  ) as Record<string, unknown>
}

function attemptSubject(
  attemptId: string,
  dispatchId: string | undefined,
  action: Record<string, unknown>
): string {
  return dispatchId ?? stringField(action, 'dispatchId') ?? attemptId
}

export function projectRelevantLedger(ledger: WatcherLedger): LedgerProjection {
  const attempts = new Map<string, AttemptItem>()
  const attemptKeysById = new Map<string, string>()
  const approvals = new Map<string, ProjectedItem>()
  const escalations = new Map<string, ProjectedItem & { status: string }>()
  const reports = new Map<string, ReportItem>()
  for (const [sourceIndex, entry] of ledger.entries.entries()) {
    if (entry.kind === 'attempt') {
      const key = entry.action.evidenceKey
      const action = entry.action as Record<string, unknown>
      attemptKeysById.set(entry.attemptId, key)
      const value = {
        attemptId: entry.attemptId,
        fingerprint: entry.fingerprint,
        action: semanticAction(action),
        state: entry.state,
        effect: entry.effect,
        reason: entry.reason,
        failureClass: entry.failureClass,
        dispatch: entry.dispatch
          ? {
              agent: entry.dispatch.agent,
              taskKey: entry.dispatch.taskKey,
              deps: entry.dispatch.deps,
              dispatchKind: entry.dispatch.dispatchKind
            }
          : undefined,
        dispatchId: entry.dispatchId
      }
      attempts.set(key, {
        key,
        value,
        atMs: entry.atMs,
        sourceIndex,
        attemptId: entry.attemptId,
        action,
        subjectId: attemptSubject(entry.attemptId, entry.dispatchId, action),
        completed:
          entry.state === 'settled' && (entry.effect === 'landed' || entry.effect === 'not-landed')
      })
      continue
    }
    if (entry.kind === 'attempt-resolved') {
      const key = attemptKeysById.get(entry.attemptId)
      const previous = key === undefined ? undefined : attempts.get(key)
      if (key !== undefined && previous !== undefined) {
        attempts.set(key, {
          ...previous,
          value: {
            ...previous.value,
            attemptId: entry.attemptId,
            state: 'settled',
            effect: entry.effect,
            failureClass: entry.failureClass
          },
          atMs: entry.atMs,
          sourceIndex,
          completed: true
        })
      }
      continue
    }
    if (entry.kind === 'approval') {
      const key = stableJson(entry.scope)
      approvals.set(key, {
        key,
        value: sanitized({
          scope: entry.scope,
          decision: entry.decision,
          foldCount: entry.foldCount
        }),
        atMs: entry.atMs,
        sourceIndex
      })
      continue
    }
    if (entry.kind === 'escalation') {
      escalations.set(entry.escalationId, {
        key: entry.escalationId,
        value: sanitized({
          escalationId: entry.escalationId,
          escalationKind: entry.escalationKind,
          status: entry.status,
          foldCount: entry.foldCount,
          approvalScope: entry.approvalScope,
          reason: entry.reason
        }),
        status: entry.status,
        atMs: entry.atMs,
        sourceIndex
      })
      continue
    }
    if (entry.kind === 'evidence' && entry.evidenceKind === 'orchestration-mailbox') {
      const sourceSubject = entry.source?.messageId ?? entry.eventId
      const report = workerDoneReport(entry.payload, sourceSubject)
      if (report !== null) {
        reports.set(report.key, {
          key: report.key,
          value: report.report,
          subjectId: report.subjectId,
          atMs: entry.atMs,
          sourceIndex
        })
      }
    }
  }
  const byKey = <T extends ProjectedItem>(values: ReadonlyMap<string, T>): T[] =>
    [...values.values()].sort((left, right) => compareCodeUnits(left.key, right.key))
  return {
    attempts: byKey(attempts),
    approvals: byKey(approvals),
    escalations: byKey(escalations),
    latestEscalation: sanitized(latestActiveWorkerEscalation(ledger)?.report ?? null),
    reports: byKey(reports)
  }
}

export function projectLedgerState(
  projection: LedgerProjection,
  drop?: LedgerDropSelection
): JudgmentLedgerState {
  return {
    attempts: projection.attempts
      .filter((item) => !drop?.attemptKeys.has(item.key))
      .map((item) => item.value),
    approvals: projection.approvals
      .filter((item) => !drop?.approvalKeys.has(item.key))
      .map((item) => item.value),
    escalations: projection.escalations
      .filter((item) => !drop?.escalationKeys.has(item.key))
      .map((item) => item.value),
    latestEscalation: projection.latestEscalation,
    reports: projection.reports
      .filter((item) => !drop?.reportKeys.has(item.key))
      .map((item) => item.value)
  }
}
