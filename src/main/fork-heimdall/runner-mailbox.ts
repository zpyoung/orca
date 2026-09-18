import type { LedgerEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { MailboxCursor } from './orchestration/mailbox-drain'

export function mailboxBody(entry: Extract<LedgerEntry, { kind: 'evidence' }>): {
  type: string
  messageId?: string
  dispatchId?: string
  outcome?: string
  result?: unknown
  subject?: string
  body?: string
} | null {
  if (
    entry.evidenceKind !== 'orchestration-mailbox' ||
    typeof entry.payload !== 'object' ||
    entry.payload === null
  ) {
    return null
  }
  const envelope = entry.payload as Record<string, unknown>
  const type = typeof envelope.type === 'string' ? envelope.type : ''
  let payload: Record<string, unknown> = {}
  if (typeof envelope.payload === 'string') {
    try {
      const parsed: unknown = JSON.parse(envelope.payload)
      if (typeof parsed === 'object' && parsed !== null) {
        payload = parsed as Record<string, unknown>
      }
    } catch {
      payload = {}
    }
  } else if (typeof envelope.payload === 'object' && envelope.payload !== null) {
    payload = envelope.payload as Record<string, unknown>
  }
  return {
    type,
    ...(entry.source?.kind === 'orchestration' ? { messageId: entry.source.messageId } : {}),
    ...(typeof payload.dispatchId === 'string' ? { dispatchId: payload.dispatchId } : {}),
    ...(typeof payload.outcome === 'string' ? { outcome: payload.outcome } : {}),
    ...(payload.result === undefined ? {} : { result: payload.result }),
    ...(typeof envelope.subject === 'string' ? { subject: envelope.subject } : {}),
    ...(typeof envelope.body === 'string' ? { body: envelope.body } : {})
  }
}

/** The run boundary starts a replacement run's sequence namespace without deleting history. */
export function mailboxCursor(ledger: WatcherLedger): MailboxCursor {
  let cursor: MailboxCursor = { previousDeliveryId: null, lastSequence: -1 }
  for (const entry of ledger.entries) {
    if (entry.kind !== 'evidence') {
      continue
    }
    if (entry.evidenceKind === 'orchestration-run-boundary') {
      cursor = { previousDeliveryId: null, lastSequence: -1 }
    } else if (entry.source?.kind === 'orchestration') {
      cursor = {
        previousDeliveryId: entry.source.deliveryId ?? cursor.previousDeliveryId,
        lastSequence: Math.max(cursor.lastSequence, entry.source.sequence)
      }
    }
  }
  return cursor
}

export function hasSequenceSinceRunBoundary(ledger: WatcherLedger, sequence: number): boolean {
  let found = false
  for (const entry of ledger.entries) {
    if (entry.kind !== 'evidence') {
      continue
    }
    if (entry.evidenceKind === 'orchestration-run-boundary') {
      found = false
    } else if (entry.source?.kind === 'orchestration' && entry.source.sequence === sequence) {
      found = true
    }
  }
  return found
}
