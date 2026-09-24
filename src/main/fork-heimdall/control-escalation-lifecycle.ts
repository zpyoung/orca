import { getLatestEscalations } from '../../shared/fork-heimdall/ledger-queries'
import type { ApprovalScope, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import { getApprovalEscalationsToResolve } from './approval-resolution'
import type { HeimdallLedgerStore } from './ledger-store'
import { OWNER_DEVIATION_ESCALATION_KIND } from './owner/deviation-ledger'

export type AnswerEscalationPreparation =
  | { status: 'ready'; apply(): void }
  | { status: 'refused'; detail: string }

// The park entry's own escalationId embeds the owner-deviation escalation it is blocking on
// (`parkEscalationId`); decoding it here is how a generic resume tells that deviation apart from an
// unrelated, still-escalated one (a dispatch-scoped stall, say) sitting inertly in the same ledger.
function ownerEscalationParkTarget(watcherId: string, parkEscalationId: string): string | null {
  const prefix = `park:${watcherId}:owner-escalation:`
  if (!parkEscalationId.startsWith(prefix)) {
    return null
  }
  try {
    return decodeURIComponent(parkEscalationId.slice(prefix.length))
  } catch {
    return null
  }
}

/** Owns the control-plane escalation folds shared by pause, resume, approval, disarm, and answer. */
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
    const latest = getLatestEscalations(ledger)
    const resumesWorkerEscalation =
      this.latestAutomaticParkKind(ledger) === 'park-worker-escalation'
    const activeOwnerEscalationPark = latest.find(
      (entry) => entry.status === 'open' && entry.escalationKind === 'park-owner-escalation'
    )
    const resumingOwnerEscalationTarget = activeOwnerEscalationPark
      ? ownerEscalationParkTarget(watcherId, activeOwnerEscalationPark.escalationId)
      : null
    for (const entry of latest) {
      const isOpenPark = entry.status === 'open' && entry.escalationKind.startsWith('park-')
      const isUnresolvedWorkerEscalation =
        resumesWorkerEscalation &&
        (entry.status === 'open' || entry.status === 'escalated') &&
        entry.escalationKind === 'worker-escalation'
      // scoped to the one owner-deviation the active park is actually waiting on, not every
      // escalated owner-deviation — an unrelated escalated stall must not reopen (bug-165).
      const isUnresolvedOwnerEscalation =
        resumingOwnerEscalationTarget !== null &&
        (entry.status === 'open' || entry.status === 'escalated') &&
        entry.escalationKind === OWNER_DEVIATION_ESCALATION_KIND &&
        entry.escalationId === resumingOwnerEscalationTarget
      if (!isOpenPark && !isUnresolvedWorkerEscalation && !isUnresolvedOwnerEscalation) {
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

  /**
   * Validates the answer-escalation preconditions and, if met, returns the one-commit effect: a
   * fresh-budget reopening of the owner-deviation carrying the operator's reply, and acknowledgement
   * of the park it answers.
   */
  prepareAnswerEscalation(
    watcherId: string,
    escalationId: string,
    body: string
  ): AnswerEscalationPreparation {
    const ledger = this.dependencies.ledger.read(watcherId)
    const latest = getLatestEscalations(ledger)
    const parkEntry = latest.find(
      (entry) => entry.status === 'open' && entry.escalationKind === 'park-owner-escalation'
    )
    if (
      !parkEntry ||
      ownerEscalationParkTarget(watcherId, parkEntry.escalationId) !== escalationId
    ) {
      return {
        status: 'refused',
        detail: `Heimdall watcher ${watcherId} is not parked on owner escalation ${escalationId}`
      }
    }
    const deviationEntry = latest.find((entry) => entry.escalationId === escalationId)
    if (
      !deviationEntry ||
      deviationEntry.escalationKind !== OWNER_DEVIATION_ESCALATION_KIND ||
      deviationEntry.status !== 'escalated'
    ) {
      return {
        status: 'refused',
        detail: `Owner escalation ${escalationId} is not awaiting an answer`
      }
    }
    return {
      status: 'ready',
      apply: () => {
        const atMs = this.dependencies.now()
        this.dependencies.ledger.append({
          ...deviationEntry,
          eventId: this.dependencies.createId(),
          atMs,
          status: 'open',
          foldCount: 1,
          humanReply: { body, atMs }
        })
        this.dependencies.ledger.append({
          ...parkEntry,
          eventId: this.dependencies.createId(),
          atMs,
          status: 'acknowledged',
          foldCount: parkEntry.foldCount + 1
        })
      }
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
