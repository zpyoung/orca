import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type {
  WatcherEnrollment,
  WatcherListEntry,
  WatcherStatus
} from '../../shared/fork-heimdall/watcher-types'
import { dormantWatcherStatus } from './debug-report'
import type { RegisteredWatcherKind } from './registry'

export function watcherListEntry(input: {
  enrollment: WatcherEnrollment
  kind: RegisteredWatcherKind | null
  ledger: WatcherLedger
  status?: WatcherStatus
  malformedPayload: boolean
}): WatcherListEntry {
  const fallback = input.status ?? dormantWatcherStatus(input.enrollment, input.ledger)
  const status = input.malformedPayload
    ? {
        ...fallback,
        enabled: false,
        state: 'escalated' as const,
        phase: 'invalid-kind-payload',
        reason: 'Persisted kind payload failed validation'
      }
    : fallback
  return {
    enrollment: input.enrollment,
    name:
      !input.malformedPayload && input.kind
        ? input.kind.describeEnrollment(input.enrollment)
        : `${input.enrollment.kind} ${input.enrollment.watcherId}`,
    status
  }
}
