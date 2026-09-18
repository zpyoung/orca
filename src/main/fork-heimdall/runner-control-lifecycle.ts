import type { WatcherLedgerLifecycle } from './ledger-lifecycle'
import type { RunnerBudgetClock, WatcherRunner } from './runner-state'

export type RunnerControlLifecycleDependencies = {
  budgetClock: RunnerBudgetClock
  dispatchLifecycle: WatcherLedgerLifecycle
  schedule(runner: WatcherRunner, delayMs: number): void
  clearTimer(timer: NodeJS.Timeout): void
  publish(runner: WatcherRunner): void
}

/** Owns local runner suspension and shutdown without changing persisted user control state. */
export class WatcherRunnerControlLifecycle {
  constructor(private readonly dependencies: RunnerControlLifecycleDependencies) {}

  suspend(runner: WatcherRunner): void {
    runner.suspended = true
    runner.forceFresh = true
    if (runner.timer) {
      this.dependencies.clearTimer(runner.timer)
      runner.timer = null
    }
    runner.leaseRenewal?.dispose()
    runner.leaseRenewal = null
    runner.leaseGuard = null
    this.dependencies.dispatchLifecycle.closeForContactLoss(runner.enrollment.watcherId)
    const openInterval =
      this.dependencies.budgetClock.current?.(runner.enrollment.watcherId) ?? null
    if (openInterval) {
      this.dependencies.budgetClock.close(openInterval, 'contact-lost')
    }
    runner.status = { ...runner.status, phase: 'suspended', nextPulseAtMs: null }
    this.dependencies.publish(runner)
  }

  resume(runner: WatcherRunner): void {
    if (runner.stopped) {
      return
    }
    runner.suspended = false
    runner.forceFresh = true
    this.dependencies.schedule(runner, 0)
  }

  disarm(runner: WatcherRunner): void {
    if (runner.timer) {
      this.dependencies.clearTimer(runner.timer)
    }
    runner.timer = null
    runner.leaseRenewal?.dispose()
    runner.leaseRenewal = null
    runner.leaseGuard = null
    runner.status = { ...runner.status, nextPulseAtMs: null }
    this.dependencies.publish(runner)
  }

  stop(runner: WatcherRunner): void {
    runner.stopped = true
    if (runner.timer) {
      this.dependencies.clearTimer(runner.timer)
    }
    runner.timer = null
    runner.leaseRenewal?.dispose()
    runner.leaseRenewal = null
    this.dependencies.dispatchLifecycle.closeForShutdown()
    const openInterval =
      this.dependencies.budgetClock.current?.(runner.enrollment.watcherId) ?? null
    if (openInterval) {
      this.dependencies.budgetClock.close(openInterval, 'shutdown')
    }
    runner.status = { ...runner.status, nextPulseAtMs: null }
    this.dependencies.publish(runner)
  }
}
