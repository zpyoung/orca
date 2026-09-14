import { deriveBudgetState } from '../../shared/fork-heimdall/budget'
import type { LedgerEntry } from '../../shared/fork-heimdall/ledger-types'
import type { WatcherParkReason } from '../../shared/fork-heimdall/watcher-types'
import type { RunnerLedgerStore, WatcherRunner } from './runner-state'

export type WatcherRunnerStatusDependencies = {
  ledgerStore: RunnerLedgerStore
  persistEnabled: (runner: WatcherRunner, enabled: boolean) => WatcherRunner['enrollment']
  now: () => number
  createId: () => string
  publish: (runner: WatcherRunner) => void
}

export function isCoordinatorSeatLost(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'coordinator-seat-lost'
  )
}

/** Owns durable park transitions and their corresponding public status projection. */
export class WatcherRunnerStatusLifecycle {
  constructor(private readonly dependencies: WatcherRunnerStatusDependencies) {}

  park(runner: WatcherRunner, reason: WatcherParkReason): void {
    if (runner.enrollment.enabled) {
      runner.enrollment = this.dependencies.persistEnabled(runner, false)
      this.append(runner, {
        eventId: this.dependencies.createId(),
        watcherId: runner.enrollment.watcherId,
        atMs: this.dependencies.now(),
        origin: 'owner',
        class: 'fact',
        kind: 'escalation',
        escalationId: `park:${runner.enrollment.watcherId}:${reason.kind}`,
        escalationKind: `park-${reason.kind}`,
        status: 'open',
        foldCount: 1,
        reason: reason.kind === 'stop-predicate' ? reason.reason : reason.kind
      })
    }
    runner.status = {
      ...runner.status,
      enabled: false,
      state: 'parked',
      phase: 'parked',
      reason: reason.kind,
      parkReason: reason,
      budget: deriveBudgetState(
        this.dependencies.ledgerStore.read(runner.enrollment.watcherId),
        runner.enrollment.budget
      ),
      nextPulseAtMs: null
    }
    this.dependencies.publish(runner)
  }
  gate(runner: WatcherRunner, escalated: boolean, reason: string): void {
    runner.status = {
      ...runner.status,
      state: escalated ? 'escalated' : 'held',
      phase: 'gate',
      reason,
      budget: deriveBudgetState(
        this.dependencies.ledgerStore.read(runner.enrollment.watcherId),
        runner.enrollment.budget
      )
    }
    this.dependencies.publish(runner)
  }

  markSuccessful(runner: WatcherRunner, phase: string): void {
    runner.consecutiveErrors = 0
    runner.status = {
      ...runner.status,
      state: phase === 'acting' ? 'acting' : 'watching',
      phase,
      reason: null,
      lastSuccessfulTickAtMs: this.dependencies.now(),
      budget: deriveBudgetState(
        this.dependencies.ledgerStore.read(runner.enrollment.watcherId),
        runner.enrollment.budget
      )
    }
    this.dependencies.publish(runner)
  }

  private append(runner: WatcherRunner, entry: LedgerEntry): void {
    this.dependencies.ledgerStore.append(runner.enrollment.watcherId, entry)
  }
}
