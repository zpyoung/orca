import { getLatestAttempts, getLatestEscalations } from '../../shared/fork-heimdall/ledger-queries'
import type { EscalationEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import { parkedWorkerEscalationId } from '../../shared/fork-heimdall/park-escalation-id'

export type WorkerReconciliation =
  | { status: 'clear' }
  | { status: 'question'; messageId: string; dispatchId: string | null }
  | {
      status: 'escalation'
      escalationId: string
      messageId: string
      dispatchId: string | null
      reason: string
    }
  | { status: 'exited'; dispatchId: string | null }
  | { status: 'unverifiable'; dispatchId: string | null; reason: string }

function latestAutomaticPark(ledger: WatcherLedger): EscalationEntry | null {
  const halt = ledger.entries.findLast(
    (entry) =>
      entry.kind === 'escalation' &&
      (entry.escalationKind.startsWith('park-') || entry.escalationKind === 'control-disarm')
  )
  return halt?.kind === 'escalation' && halt.escalationKind.startsWith('park-') ? halt : null
}

export function parkedForWorkerQuestion(ledger: WatcherLedger): boolean {
  return latestAutomaticPark(ledger)?.escalationKind === 'park-worker-question'
}

/**
 * Whether a worker-escalation park has become self-clearing: the escalation that caused it is no
 * longer unresolved and the dispatch that raised it settled as landed. A dispatch that failed or
 * was confirmed exited stays parked, so an operator still reads the report that went wrong.
 */
export function workerEscalationParkRecovered(ledger: WatcherLedger): boolean {
  const park = latestAutomaticPark(ledger)
  if (
    park?.escalationKind !== 'park-worker-escalation' ||
    unresolvedWorkerEscalations(ledger).length > 0
  ) {
    return false
  }
  const escalationId = parkedWorkerEscalationId(park.watcherId, park.escalationId)
  const dispatchId = escalationId ? parseWorkerEscalationId(escalationId)?.dispatchId : null
  return (
    dispatchId !== null &&
    dispatchId !== undefined &&
    getLatestAttempts(ledger).some(
      (attempt) =>
        attempt.dispatchId === dispatchId &&
        attempt.state === 'settled' &&
        attempt.effect === 'landed'
    )
  )
}

export function unresolvedWorkerEscalations(ledger: WatcherLedger): readonly EscalationEntry[] {
  return getLatestEscalations(ledger).filter(
    (entry) =>
      entry.escalationKind === 'worker-escalation' &&
      (entry.status === 'open' || entry.status === 'escalated')
  )
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

/** Inverts appendWorkerEscalation's `worker-escalation:<dispatchId>:<messageId>` encoding. */
export function parseWorkerEscalationId(
  escalationId: string
): { dispatchId: string | null; messageId: string | null } | null {
  const parts = escalationId.split(':')
  if (parts.length !== 3 || parts[0] !== 'worker-escalation') {
    return null
  }
  return { dispatchId: decodeSegment(parts[1]), messageId: decodeSegment(parts[2]) }
}

export function workerEscalationMessageId(escalationId: string): string {
  return parseWorkerEscalationId(escalationId)?.messageId ?? escalationId
}
