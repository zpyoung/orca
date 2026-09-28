import type { EvidenceEntry } from '../../../shared/fork-heimdall/ledger-types'
import type { WatcherEnrollment } from '../../../shared/fork-heimdall/watcher-types'
import type { AttemptObservationFact, OrchestrationDb } from '../../runtime/orchestration/db'
import { parseLifecycleRejectionPayload } from './lifecycle-rejection-payload'
import { mailboxEvidenceForMessage } from './mailbox-drain'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

type AcceptedWorkerReportResult = {
  provenance: 'worker_report'
  outcome: 'succeeded' | 'failed'
  messageId: string
  body: string
}

type RejectedWorkerReportResult = {
  provenance: 'worker_report_rejected'
  outcome: 'failed'
  reportedOutcome: 'succeeded' | 'failed'
  messageId: string
  body: string
  reportRejection: { code: string; reason: string }
}

export function readAuthoritativeWorkerReportEvidence(input: {
  db: OrchestrationDb
  enrollment: WatcherEnrollment
  runId: string
  dispatchId: string
}): EvidenceEntry | null {
  const dispatch = input.db.getDispatchContextById(input.dispatchId)
  if (!dispatch || dispatch.run_id !== input.runId) {
    return null
  }
  const facts = input.db.getAttemptObservationFacts(input.dispatchId)
  const task = input.db.getTask(dispatch.task_id)
  if (!task || task.run_id !== input.runId || !task.result) {
    return null
  }
  const result = parseWorkerReportResult(task.result)
  if (!result) {
    return null
  }
  const reportId = `worker_report:${result.messageId}`
  const reportFact = facts.find(
    (fact): fact is Extract<AttemptObservationFact, { facet: 'worker_report' }> =>
      fact.id === reportId && fact.facet === 'worker_report'
  )
  if (
    !reportFact ||
    reportFact.dispatchId !== input.dispatchId ||
    reportFact.taskId !== dispatch.task_id ||
    reportFact.authorityId !== `run_home:${input.runId}` ||
    reportFact.payload.reportId !== reportId
  ) {
    return null
  }
  const message = input.db.getMessageById(result.messageId)
  const messagePayload = parseObject(message?.payload)
  if (
    !message ||
    !messagePayload ||
    message.run_id !== input.runId ||
    message.type !== 'worker_done' ||
    reportFact.homeReceivedAt !== Date.parse(message.created_at) ||
    messagePayload.dispatchId !== input.dispatchId ||
    messagePayload.taskId !== dispatch.task_id
  ) {
    return null
  }

  if (result.provenance === 'worker_report') {
    if (
      message.body !== result.body ||
      reportFact.payload.status !== 'accepted' ||
      reportFact.payload.outcome !== result.outcome ||
      messagePayload.outcome !== result.outcome
    ) {
      return null
    }
  } else {
    const messageRejection = parseReportRejection(messagePayload)
    if (
      reportFact.payload.status !== 'rejected' ||
      reportFact.payload.reason !== result.reportRejection.reason ||
      task.status !== 'failed' ||
      messagePayload.outcome !== result.reportedOutcome ||
      !messageRejection ||
      messageRejection.code !== result.reportRejection.code ||
      messageRejection.reason !== result.reportRejection.reason ||
      messageRejection.originalBody !== result.body
    ) {
      return null
    }
  }
  return mailboxEvidenceForMessage(input.enrollment, null, message, false)
}

function parseWorkerReportResult(
  result: string
): AcceptedWorkerReportResult | RejectedWorkerReportResult | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(result)
  } catch {
    return null
  }
  if (!isRecord(parsed)) {
    return null
  }
  const record = parsed
  if (
    typeof record.messageId !== 'string' ||
    !record.messageId.trim() ||
    typeof record.body !== 'string'
  ) {
    return null
  }
  if (
    record.provenance === 'worker_report' &&
    (record.outcome === 'succeeded' || record.outcome === 'failed')
  ) {
    return {
      provenance: record.provenance,
      outcome: record.outcome,
      messageId: record.messageId,
      body: record.body
    }
  }
  if (
    record.provenance !== 'worker_report_rejected' ||
    record.outcome !== 'failed' ||
    (record.reportedOutcome !== 'succeeded' && record.reportedOutcome !== 'failed')
  ) {
    return null
  }
  const reportRejection = parsePreflightRejection(record.preflightRejection)
  if (!reportRejection) {
    return null
  }
  return {
    provenance: record.provenance,
    outcome: record.outcome,
    reportedOutcome: record.reportedOutcome,
    messageId: record.messageId,
    body: record.body,
    reportRejection
  }
}

function parseObject(payload: string | null | undefined): Record<string, unknown> | null {
  if (!payload) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(payload)
    return isRecord(parsed) && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function parsePreflightRejection(value: unknown): { code: string; reason: string } | null {
  if (!isRecord(value)) {
    return null
  }
  const rejection = value
  if (
    typeof rejection.code !== 'string' ||
    !rejection.code.trim() ||
    typeof rejection.reason !== 'string'
  ) {
    return null
  }
  return { code: rejection.code, reason: rejection.reason }
}

function parseReportRejection(
  payload: Record<string, unknown>
): { code: string; reason: string; originalBody: string } | null {
  const parsed = parseLifecycleRejectionPayload(payload)
  return parsed && typeof parsed.originalBody === 'string'
    ? { code: parsed.code, reason: parsed.reason, originalBody: parsed.originalBody }
    : null
}
