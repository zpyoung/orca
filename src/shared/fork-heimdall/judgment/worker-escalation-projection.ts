import { getLatestEscalations } from '../ledger-queries'
import type { LedgerEntry, WatcherLedger } from '../ledger-types'
import { workerEscalationConsumedMessageId } from '../worker-escalation-consumption'

export type ActiveWorkerEscalation = {
  subjectId: string
  report: {
    type: 'escalation'
    subjectId: string
    payload: Record<string, unknown>
    subject?: string
    body?: string
  }
}

function workerEscalationMessageId(escalationId: string): string | null {
  const prefix = 'worker-escalation:'
  if (!escalationId.startsWith(prefix)) {
    return null
  }
  const encoded = escalationId.slice(prefix.length)
  const separator = encoded.indexOf(':')
  if (separator === -1 || separator === encoded.length - 1) {
    return null
  }
  try {
    return decodeURIComponent(encoded.slice(separator + 1))
  } catch {
    return null
  }
}

function mailboxEscalation(entry: LedgerEntry): ActiveWorkerEscalation | null {
  if (
    entry.kind !== 'evidence' ||
    entry.evidenceKind !== 'orchestration-mailbox' ||
    entry.payload === null ||
    typeof entry.payload !== 'object' ||
    Array.isArray(entry.payload)
  ) {
    return null
  }
  const message = entry.payload as Record<string, unknown>
  if (message.type !== 'escalation') {
    return null
  }
  const subjectId = entry.source?.messageId ?? entry.eventId
  const body =
    message.payload !== null &&
    typeof message.payload === 'object' &&
    !Array.isArray(message.payload)
      ? (message.payload as Record<string, unknown>)
      : {}
  return {
    subjectId,
    report: {
      type: 'escalation',
      subjectId,
      payload: body,
      ...(typeof message.subject === 'string' ? { subject: message.subject } : {}),
      ...(typeof message.body === 'string' ? { body: message.body } : {})
    }
  }
}

/**
 * Projects the newest worker escalation that still awaits operator resolution. A consumption marker
 * only records that the runner parked for the message; the folded durable escalation status owns
 * whether it remains active.
 */
export function latestActiveWorkerEscalation(ledger: WatcherLedger): ActiveWorkerEscalation | null {
  const durableMessageIds = new Set<string>()
  const activeMessageIds = new Set<string>()
  for (const escalation of getLatestEscalations(ledger)) {
    if (escalation.escalationKind !== 'worker-escalation') {
      continue
    }
    const messageId = workerEscalationMessageId(escalation.escalationId)
    if (messageId === null) {
      continue
    }
    durableMessageIds.add(messageId)
    if (escalation.status === 'open' || escalation.status === 'escalated') {
      activeMessageIds.add(messageId)
    }
  }

  let hasDurableMailboxMatch = false
  const consumedMessageIds = new Set<string>()
  const fallback: ActiveWorkerEscalation[] = []
  for (const entry of ledger.entries) {
    if (entry.kind === 'evidence' && entry.evidenceKind === 'worker-escalation-consumed') {
      const messageId = workerEscalationConsumedMessageId(entry.payload)
      if (messageId !== null) {
        consumedMessageIds.add(messageId)
      }
      continue
    }
    const escalation = mailboxEscalation(entry)
    if (escalation === null) {
      continue
    }
    if (durableMessageIds.has(escalation.subjectId)) {
      hasDurableMailboxMatch = true
    }
    if (activeMessageIds.has(escalation.subjectId)) {
      fallback.push(escalation)
    }
  }
  if (fallback.length > 0) {
    return fallback.at(-1) ?? null
  }
  if (hasDurableMailboxMatch) {
    return null
  }

  for (let index = ledger.entries.length - 1; index >= 0; index -= 1) {
    const escalation = mailboxEscalation(ledger.entries[index])
    if (escalation && !consumedMessageIds.has(escalation.subjectId)) {
      return escalation
    }
  }
  return null
}
