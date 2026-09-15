import type { FiredStopPredicate } from '../../shared/fork-heimdall/stop-policy'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import {
  isMalformedKindPayloadEnrollment,
  type EnrollmentRecord,
  type EnrollmentStore
} from './enrollment-store'
import type { HeimdallLedgerStore } from './ledger-store'

export type KernelTerminalTransitionDependencies = {
  enrollments: EnrollmentStore
  ledger: HeimdallLedgerStore
  now(): number
  createId(): string
}

/** Atomically joins the kernel terminal fact to the enrollment's terminal marker. */
export class KernelTerminalTransition {
  constructor(private readonly dependencies: KernelTerminalTransitionDependencies) {}

  commit(enrollment: WatcherEnrollment, fired: FiredStopPredicate): WatcherEnrollment {
    const atMs = this.dependencies.now()
    const updated = this.dependencies.enrollments.markTerminal(enrollment.watcherId, atMs, () => {
      this.dependencies.ledger.append({
        eventId: this.dependencies.createId(),
        watcherId: enrollment.watcherId,
        atMs,
        origin: 'owner',
        class: 'fact',
        kind: 'terminal',
        state: fired.predicateId,
        reason: fired.reason
      })
    })
    return this.requireValid(updated)
  }

  recover(enrollment: WatcherEnrollment, writable = true): WatcherEnrollment {
    if (enrollment.terminalAtMs !== null) {
      return enrollment
    }
    const terminal = this.dependencies.ledger
      .read(enrollment.watcherId)
      .entries.find((entry) => entry.kind === 'terminal')
    if (!terminal || terminal.kind !== 'terminal') {
      return enrollment
    }
    if (!writable) {
      return {
        ...enrollment,
        enabled: false,
        paused: false,
        terminalAtMs: terminal.atMs
      }
    }
    return this.requireValid(
      this.dependencies.enrollments.markTerminal(enrollment.watcherId, terminal.atMs)
    )
  }

  private requireValid(record: EnrollmentRecord): WatcherEnrollment {
    if (isMalformedKindPayloadEnrollment(record)) {
      throw new Error(`Heimdall watcher ${record.watcherId} kind payload is malformed`)
    }
    return record
  }
}
