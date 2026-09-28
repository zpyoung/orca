import { errorBackoffMs, HEIMDALL_RAPID_POLL_MS } from '../../shared/fork-heimdall/pacing'
import type { WatcherTickTrace } from '../../shared/fork-heimdall/tick-trace'
import type { WatcherLedgerLifecycle } from './ledger-lifecycle'
import { errorText } from './runner-actions'
import { isCoordinatorSeatLost, type WatcherRunnerStatusLifecycle } from './runner-status'
import type { WatcherRunner } from './runner-state'

type RunnerErrorLifecycleDependencies = {
  dispatchLifecycle: WatcherLedgerLifecycle
  statusLifecycle: WatcherRunnerStatusLifecycle
  schedule(runner: WatcherRunner, delayMs: number): void
  publish(runner: WatcherRunner): void
  disarm(runner: WatcherRunner): void
  releaseLease(
    runner: WatcherRunner,
    guard: NonNullable<WatcherRunner['leaseGuard']>
  ): Promise<void>
}

/** Converts pulse failures into durable runner status without obscuring owner-seat loss. */
export class WatcherRunnerErrorLifecycle {
  constructor(private readonly dependencies: RunnerErrorLifecycleDependencies) {}
  async parkForConfigurationError(runner: WatcherRunner, reason: string): Promise<void> {
    const retainedGuard = runner.leaseGuard
    this.dependencies.statusLifecycle.configurationError(runner, reason)
    if (retainedGuard) {
      await this.dependencies.releaseLease(runner, retainedGuard)
    }
    this.dependencies.disarm(runner)
    runner.reconcileAgain = false
  }

  async handle(
    runner: WatcherRunner,
    error: unknown,
    trace: WatcherTickTrace,
    tickLease: WatcherRunner['leaseGuard']
  ): Promise<boolean> {
    this.dependencies.dispatchLifecycle.closeForContactLoss(runner.enrollment.watcherId)
    if (isCoordinatorSeatLost(error)) {
      trace.exitPath = 'gate-escalated'
      trace.error = null
      this.dependencies.statusLifecycle.park(runner, { kind: 'coordinator-seat-lost' })
      if (tickLease) {
        await this.dependencies.releaseLease(runner, tickLease)
      }
      return false
    }
    trace.exitPath = 'error'
    trace.error = {
      message: errorText(error),
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {})
    }
    runner.consecutiveErrors += 1
    runner.status = {
      ...runner.status,
      state: 'unreachable',
      phase: 'error',
      reason: errorText(error),
      nextPulseAtMs: null
    }
    this.dependencies.publish(runner)
    this.dependencies.schedule(
      runner,
      errorBackoffMs(runner.consecutiveErrors) ?? HEIMDALL_RAPID_POLL_MS
    )
    return true
  }
}
