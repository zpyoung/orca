import { getLatestEscalations } from '../../shared/fork-heimdall/ledger-queries'
import type { ApprovalScope, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import { getApprovalEscalationsToResolve } from './approval-resolution'
import type { HeimdallLedgerStore } from './ledger-store'

/** Owns the control-plane escalation folds shared by pause, resume, approval, and disarm. */
export class WatcherControlEscalationLifecycle {
  constructor(
    private readonly dependencies: {
      ledger: HeimdallLedgerStore
      now(): number
      createId(): string
    }
  ) {}

  latestAutomaticParkKind(ledger: WatcherLedger): string | null {
    const halt = ledger.entries
      .toReversed()
      .find(
        (entry) =>
          entry.kind === 'escalation' &&
          (entry.escalationKind.startsWith('park-') || entry.escalationKind === 'control-disarm')
      )
    return halt?.kind === 'escalation' && halt.escalationKind.startsWith('park-')
      ? halt.escalationKind
      : null
  }

  hasOpenWorkerQuestion(watcherId: string, messageId: string): boolean {
    return getLatestEscalations(this.dependencies.ledger.read(watcherId)).some(
      (entry) =>
        entry.status === 'open' &&
        entry.escalationKind === 'worker-question' &&
        entry.escalationId.endsWith(`:${messageId}`)
    )
  }

  appendApprovalResolution(watcherId: string, scope: ApprovalScope): void {
    for (const entry of getApprovalEscalationsToResolve(
      this.dependencies.ledger.read(watcherId),
      scope
    )) {
      this.dependencies.ledger.append({
        ...entry,
        eventId: this.dependencies.createId(),
        atMs: this.dependencies.now(),
        status: 'resolved',
        foldCount: entry.foldCount + 1
      })
    }
  }

  appendResumeTransitions(watcherId: string): void {
    const ledger = this.dependencies.ledger.read(watcherId)
    const resumesWorkerEscalation =
      this.latestAutomaticParkKind(ledger) === 'park-worker-escalation'
    for (const entry of getLatestEscalations(ledger)) {
      const isOpenPark = entry.status === 'open' && entry.escalationKind.startsWith('park-')
      const isUnresolvedWorkerEscalation =
        resumesWorkerEscalation &&
        (entry.status === 'open' || entry.status === 'escalated') &&
        entry.escalationKind === 'worker-escalation'
      if (!isOpenPark && !isUnresolvedWorkerEscalation) {
        continue
      }
      this.dependencies.ledger.append({
        ...entry,
        eventId: this.dependencies.createId(),
        atMs: this.dependencies.now(),
        status: 'acknowledged',
        foldCount: entry.foldCount + 1
      })
    }
  }

  appendDisarmTransitions(watcherId: string): void {
    for (const entry of getLatestEscalations(this.dependencies.ledger.read(watcherId))) {
      if (entry.status !== 'open') {
        continue
      }
      this.dependencies.ledger.append({
        ...entry,
        eventId: this.dependencies.createId(),
        atMs: this.dependencies.now(),
        status: 'resolved',
        foldCount: entry.foldCount + 1
      })
    }
    this.dependencies.ledger.append({
      eventId: this.dependencies.createId(),
      watcherId,
      atMs: this.dependencies.now(),
      origin: 'owner',
      class: 'fact',
      kind: 'escalation',
      escalationId: `control-disarm:${watcherId}:${this.dependencies.createId()}`,
      escalationKind: 'control-disarm',
      status: 'resolved',
      foldCount: 1,
      reason: 'explicit-disarm'
    })
  }
}
