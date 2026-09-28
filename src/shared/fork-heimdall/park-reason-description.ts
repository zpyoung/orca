import type { WatcherParkReason } from './watcher-types'

/**
 * The operator-facing sentence for a park reason. Kinds that carry a persisted human sentence
 * (`stop-predicate`, `configuration-error`, `owner-escalation`) return it; `worker-escalation`
 * returns the escalation it is waiting on; the remaining kinds have no sentence beyond their name.
 */
export function describeParkReason(reason: WatcherParkReason): string {
  switch (reason.kind) {
    case 'stop-predicate':
    case 'configuration-error':
    case 'owner-escalation':
      return reason.reason
    case 'worker-escalation':
      return reason.escalationId
    case 'budget':
    case 'worker-question':
    case 'coordinator-seat-lost':
      return reason.kind
  }
}
