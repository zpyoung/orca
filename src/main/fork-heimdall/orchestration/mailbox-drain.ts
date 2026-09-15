import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { MessageRow, OrchestrationDb, RunRow } from '../../runtime/orchestration/db'
import { OrchestrationError } from '../../runtime/orchestration/orchestration-error'
import { checkRunMailbox } from '../../runtime/rpc/methods/orchestration/messaging/check-run'
import type { EvidenceEntry, LedgerEntry } from '../../../shared/fork-heimdall/ledger-types'
import type { WatcherEnrollment } from '../../../shared/fork-heimdall/watcher-types'

export type MailboxCursor = Readonly<{
  previousDeliveryId: string | null
  lastSequence: number
}>

export type MailboxDrainInput = Readonly<{
  enrollment: WatcherEnrollment
  cursor: MailboxCursor
}>

type MailboxCheckResult = {
  runId: string
  deliveryId: string | null
  messages: { id: string }[]
}

export async function drainHeimdallMailbox(input: {
  runtime: OrcaRuntimeService
  enrollment: WatcherEnrollment
  run: RunRow
  cursor: MailboxCursor
}): Promise<LedgerEntry[]> {
  assertMailboxCursor(input.cursor)
  const db = input.runtime.getOrchestrationDb()
  const identity = input.enrollment.coordinatorIdentity
  const checked = (await checkRunMailbox({
    params: {
      terminal: identity.handle,
      terminalPaneKey: identity.paneKey,
      run: input.run.id,
      ...(input.cursor.previousDeliveryId ? { ack: input.cursor.previousDeliveryId } : {})
    },
    runtime: input.runtime,
    db,
    handle: identity.handle,
    paneKey: identity.paneKey,
    typeFilter: undefined,
    signal: undefined,
    legacyCoordinatorRunId: undefined,
    revalidateLegacyCoordinator: undefined,
    orchestrationCompatibilityEvidence: undefined,
    recordMutationReceipt: undefined
  })) as MailboxCheckResult

  if (checked.runId !== input.run.id) {
    throw new OrchestrationError(
      'consumer_fenced',
      `Mailbox resolved Run ${checked.runId}, expected ${input.run.id}`
    )
  }
  if (checked.messages.length > 0 && !checked.deliveryId) {
    throw new Error(`Mailbox for Run ${input.run.id} returned messages without a delivery receipt`)
  }

  return checked.messages
    .map(({ id }) => requireMailboxMessage(db, input.run.id, id))
    .filter((message) => message.sequence > input.cursor.lastSequence)
    .sort((left, right) => left.sequence - right.sequence)
    .map((message) => mailboxEvidence(input.enrollment, checked.deliveryId, message))
}

function assertMailboxCursor(cursor: MailboxCursor): void {
  if (!Number.isSafeInteger(cursor.lastSequence) || cursor.lastSequence < -1) {
    throw new Error('Mailbox lastSequence must be a safe integer greater than or equal to -1')
  }
}

function requireMailboxMessage(db: OrchestrationDb, runId: string, id: string): MessageRow {
  const message = db.getMessageById(id)
  if (!message || message.run_id !== runId) {
    throw new Error(`Mailbox message ${id} was not found in Run ${runId}`)
  }
  return message
}

function mailboxEvidence(
  enrollment: WatcherEnrollment,
  deliveryId: string | null,
  message: MessageRow
): EvidenceEntry {
  const atMs = Date.parse(message.created_at)
  if (!Number.isFinite(atMs) || atMs < 0) {
    throw new Error(`Mailbox message ${message.id} has an invalid created_at timestamp`)
  }
  return {
    eventId: `orchestration-mail:${message.id}`,
    watcherId: enrollment.watcherId,
    atMs,
    origin: 'owner',
    class: 'fact',
    kind: 'evidence',
    evidenceKind: 'orchestration-mailbox',
    source: {
      kind: 'orchestration',
      sequence: message.sequence,
      messageId: message.id,
      ...(deliveryId ? { deliveryId } : {})
    },
    payload: normalizedMailboxFact(message)
  }
}

function normalizedMailboxFact(message: MessageRow): {
  type: MessageRow['type']
  subject?: string
  body?: string
  payload: {
    dispatchId?: string
    taskId?: string
    outcome?: string
    result?: string
    reportPath?: string
    filesModified?: string[]
  }
} {
  let raw: Record<string, unknown> = {}
  if (message.payload) {
    try {
      const parsed: unknown = JSON.parse(message.payload)
      if (typeof parsed === 'object' && parsed !== null) {
        raw = parsed as Record<string, unknown>
      }
    } catch {
      raw = {}
    }
  }
  return {
    type: message.type,
    payload: {
      ...(typeof raw.dispatchId === 'string' ? { dispatchId: raw.dispatchId } : {}),
      ...(typeof raw.taskId === 'string' ? { taskId: raw.taskId } : {}),
      ...(message.type === 'worker_done' && typeof raw.outcome === 'string'
        ? { outcome: raw.outcome }
        : {}),
      ...(message.type === 'worker_done' && typeof raw.reportPath === 'string'
        ? { reportPath: raw.reportPath }
        : {}),
      ...(message.type === 'worker_done' &&
      Array.isArray(raw.filesModified) &&
      raw.filesModified.every((file): file is string => typeof file === 'string')
        ? { filesModified: raw.filesModified }
        : {}),
      ...(message.type === 'worker_done' ? { result: message.body } : {})
    },
    ...(message.type === 'escalation' ? { subject: message.subject } : {}),
    ...(message.type === 'question' || message.type === 'escalation' ? { body: message.body } : {})
  }
}
