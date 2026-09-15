import {
  getInFlightAttempts,
  getLatestAttempts,
  getUnresolvedAttempts
} from '../../shared/fork-heimdall/ledger-queries'
import type {
  AttemptEntry,
  LedgerEntry,
  WatcherLedger
} from '../../shared/fork-heimdall/ledger-types'
import {
  requireLiveSnapshot,
  type LiveSnapshot,
  type Snapshot
} from '../../shared/fork-heimdall/snapshot'
import type { RunnerLedgerStore, WatcherRunner } from './runner-state'

export type WatcherAttemptRecoveryDependencies = {
  ledgerStore: RunnerLedgerStore
  now(): number
  createId(): string
  replay(
    runner: WatcherRunner,
    snapshot: Snapshot<unknown>,
    attempt: AttemptEntry
  ): Promise<boolean>
}

/** Resolves write-ahead gaps without guessing whether an unmarked side effect is safe to repeat. */
export class WatcherAttemptRecovery {
  constructor(private readonly dependencies: WatcherAttemptRecoveryDependencies) {}

  async recover(
    runner: WatcherRunner,
    snapshot: Snapshot<unknown>,
    ledger: WatcherLedger
  ): Promise<void> {
    const live = requireLiveSnapshot(snapshot)
    await this.resolveUncertainAttempts(runner, live, ledger, getUnresolvedAttempts(ledger))
    for (const attempt of getInFlightAttempts(ledger)) {
      if (attempt.state !== 'attempted' || attempt.dispatch) {
        continue
      }
      if (attempt.action.contentIdentity !== live.contentIdentity) {
        continue
      }
      const effect = await runner.kind.resolveOutcome(attempt, live, ledger)
      await this.assertLeaseHeld(runner)
      if (effect === 'not-landed' && attempt.action.recovery === 'replay-safe') {
        await this.dependencies.replay(runner, snapshot, attempt)
        continue
      }
      this.append(runner, {
        ...attempt,
        eventId: this.dependencies.createId(),
        atMs: this.dependencies.now(),
        state: 'settled',
        effect,
        reason: 'local-action-recovery-probe'
      })
    }

    if (
      getUnresolvedAttempts(this.dependencies.ledgerStore.read(runner.enrollment.watcherId))
        .length === 0
    ) {
      this.releaseTracePins(runner)
    }
  }

  settleRecoveredNotRun(runner: WatcherRunner, attempt: AttemptEntry): void {
    const latest = getLatestAttempts(
      this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
    ).find((candidate) => candidate.attemptId === attempt.attemptId)
    if (latest?.state !== 'attempted') {
      return
    }
    this.append(runner, {
      ...latest,
      eventId: this.dependencies.createId(),
      atMs: this.dependencies.now(),
      state: 'settled',
      effect: 'not-landed',
      reason: 'recovery-execution-disabled'
    })
  }

  settleAbsentDispatches(runner: WatcherRunner, attempts: readonly AttemptEntry[]): void {
    for (const attempt of attempts) {
      const latest = getLatestAttempts(
        this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
      ).find((candidate) => candidate.attemptId === attempt.attemptId)
      if (latest?.state !== 'attempted') {
        continue
      }
      this.append(runner, {
        ...latest,
        eventId: this.dependencies.createId(),
        atMs: this.dependencies.now(),
        state: 'settled',
        effect: 'not-landed',
        reason: 'dispatch-receipt-absent'
      })
    }
  }

  abandonPendingAttempts(runner: WatcherRunner, ledger: WatcherLedger): void {
    for (const attempt of getInFlightAttempts(ledger)) {
      if (attempt.state !== 'attempted') {
        continue
      }
      this.append(runner, {
        ...attempt,
        eventId: this.dependencies.createId(),
        atMs: this.dependencies.now(),
        state: 'settled',
        effect: 'not-landed',
        reason: 'workspace-moved'
      })
      this.append(runner, {
        eventId: this.dependencies.createId(),
        watcherId: runner.enrollment.watcherId,
        atMs: this.dependencies.now(),
        origin: 'owner',
        class: 'observation',
        kind: 'attempt-abandoned',
        fingerprint: attempt.fingerprint,
        reason: 'workspace-moved'
      })
    }
  }

  private async resolveUncertainAttempts(
    runner: WatcherRunner,
    live: LiveSnapshot<unknown>,
    ledger: WatcherLedger,
    attempts: readonly AttemptEntry[]
  ): Promise<void> {
    for (const attempt of attempts) {
      const effect = await runner.kind.resolveOutcome(attempt, live, ledger)
      await this.assertLeaseHeld(runner)
      if (effect === 'indeterminate') {
        continue
      }
      this.append(runner, {
        eventId: this.dependencies.createId(),
        watcherId: runner.enrollment.watcherId,
        atMs: this.dependencies.now(),
        origin: 'owner',
        class: 'fact',
        kind: 'attempt-resolved',
        attemptId: attempt.attemptId,
        effect,
        evidence: runner.kind.describeSnapshot(live)
      })
    }
  }

  private releaseTracePins(runner: WatcherRunner): void {
    for (const trace of runner.traces) {
      if (!trace.pinned) {
        continue
      }
      this.dependencies.ledgerStore.releaseTickTracePin(runner.enrollment.watcherId, trace.seq)
      trace.pinned = false
    }
  }

  private async assertLeaseHeld(runner: WatcherRunner): Promise<void> {
    if (!runner.leaseGuard) {
      throw new Error('Watcher recovery reached persistence without a lease')
    }
    await runner.leaseGuard.assertHeld()
  }

  private append(runner: WatcherRunner, entry: LedgerEntry): void {
    this.dependencies.ledgerStore.append(runner.enrollment.watcherId, entry)
  }
}
