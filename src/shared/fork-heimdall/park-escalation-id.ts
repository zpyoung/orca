import type { WatcherParkReason } from './watcher-types'

/**
 * Builds the escalation identity a park writes. A stop predicate that wants to see its own
 * acknowledgement must read this id rather than rebuild the string, and must not key off
 * `escalationKind` — that is only ever `park-<reason kind>`, with no predicate id in it.
 */
export function stopPredicateParkEscalationId(watcherId: string, predicateId: string): string {
  return `park:${watcherId}:stop-predicate:${encodeURIComponent(predicateId)}`
}

export function parkEscalationId(watcherId: string, reason: WatcherParkReason): string {
  if (reason.kind === 'stop-predicate') {
    return stopPredicateParkEscalationId(watcherId, reason.predicateId)
  }
  const detail =
    reason.kind === 'worker-question'
      ? reason.messageId
      : reason.kind === 'budget'
        ? reason.exhaustion.kind
        : null
  const base = `park:${watcherId}:${reason.kind}`
  return detail === null ? base : `${base}:${encodeURIComponent(detail)}`
}
