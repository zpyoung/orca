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
  if (reason.kind === 'worker-escalation') {
    return workerEscalationParkId(watcherId, reason.escalationId)
  }
  const detail =
    reason.kind === 'worker-question'
      ? reason.messageId
      : reason.kind === 'budget'
        ? reason.exhaustion.kind
        : reason.kind === 'owner-escalation'
          ? reason.escalationId
          : null
  const base = `park:${watcherId}:${reason.kind}`
  return detail === null ? base : `${base}:${encodeURIComponent(detail)}`
}

/**
 * The escalation identity a worker-escalation park writes. It embeds the worker escalation that
 * halted the watcher so recovery can tell which dispatch the park is waiting on.
 */
export function workerEscalationParkId(watcherId: string, escalationId: string): string {
  return `park:${watcherId}:worker-escalation:${encodeURIComponent(escalationId)}`
}

/** Inverse of `workerEscalationParkId`; null for any id it did not build. */
export function parkedWorkerEscalationId(watcherId: string, parkId: string): string | null {
  const prefix = `park:${watcherId}:worker-escalation:`
  if (!parkId.startsWith(prefix)) {
    return null
  }
  try {
    return decodeURIComponent(parkId.slice(prefix.length))
  } catch {
    return null
  }
}
