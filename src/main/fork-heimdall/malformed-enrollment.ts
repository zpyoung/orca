import type { LedgerEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import type { EnrollmentStore } from './enrollment-store'

export class MalformedEnrollmentLifecycle {
  private readonly watcherIds = new Set<string>()

  constructor(
    private readonly dependencies: {
      enrollments: EnrollmentStore
      readLedger(watcherId: string): WatcherLedger
      appendLedger(watcherId: string, entry: LedgerEntry): void
      now(): number
      createId(): string
    }
  ) {}

  has(watcherId: string): boolean {
    return this.watcherIds.has(watcherId)
  }

  record(enrollment: Pick<WatcherEnrollment, 'watcherId'>, writable: boolean): void {
    this.watcherIds.add(enrollment.watcherId)
    if (!writable) {
      return
    }
    if (
      this.dependencies
        .readLedger(enrollment.watcherId)
        .entries.some(
          (entry) => entry.kind === 'escalation' && entry.escalationKind === 'invalid-kind-payload'
        )
    ) {
      return
    }
    this.dependencies.appendLedger(enrollment.watcherId, {
      eventId: this.dependencies.createId(),
      watcherId: enrollment.watcherId,
      atMs: this.dependencies.now(),
      origin: 'owner',
      class: 'fact',
      kind: 'escalation',
      escalationId: `invalid-kind-payload:${enrollment.watcherId}`,
      escalationKind: 'invalid-kind-payload',
      status: 'open',
      foldCount: 1,
      reason: 'Persisted kind payload failed validation'
    })
    this.dependencies.enrollments.setEnabled(enrollment.watcherId, false)
  }
}
