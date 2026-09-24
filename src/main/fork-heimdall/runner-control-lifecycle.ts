import type { WatcherLedgerLifecycle } from './ledger-lifecycle'
import type { RunnerBudgetClock, WatcherRunner } from './runner-state'

export type RunnerControlLifecycleDependencies = {
  budgetClock: RunnerBudgetClock
  dispatchLifecycle: WatcherLedgerLifecycle
  schedule(runner: WatcherRunner, delayMs: number): void
  clearTimer(timer: NodeJS.Timeout): void
  publish(runner: WatcherRunner): void
}
export type RunnerDeleteFence = {
  wasStopped: boolean
  shouldResume: boolean
}
export class WatcherDeletePendingError extends Error {
  constructor() {
    super('Watcher deletion superseded the in-flight transition')
    this.name = 'WatcherDeletePendingError'
  }
}

/** Owns local runner suspension, deletion quiescence, and shutdown without worker process control. */
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
    this.closeOwnedBudgetInterval(runner, 'contact-lost')
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

  beginDelete(runner: WatcherRunner): RunnerDeleteFence {
    const fence = {
      wasStopped: runner.stopped,
      shouldResume: runner.timer !== null || runner.tickQueued || runner.reconcileAgain
    }
    runner.controlPending = 'delete'
    runner.stopped = true
    if (runner.timer) {
      this.dependencies.clearTimer(runner.timer)
      runner.timer = null
    }
    return fence
  }

  rollbackDelete(runner: WatcherRunner, fence: RunnerDeleteFence): void {
    runner.controlPending = null
    runner.stopped = fence.wasStopped || runner.enrollment.terminalAtMs !== null
    if (
      !runner.stopped &&
      (fence.shouldResume || (runner.enrollment.enabled && !runner.enrollment.paused))
    ) {
      this.dependencies.schedule(runner, 0)
    }
  }

  remove(runner: WatcherRunner): void {
    runner.stopped = true
    runner.controlPending = 'delete'
    if (runner.timer) {
      this.dependencies.clearTimer(runner.timer)
    }
    runner.timer = null
    runner.leaseRenewal?.dispose()
    runner.leaseRenewal = null
    runner.leaseGuard = null
    try {
      this.dependencies.dispatchLifecycle.closeForContactLoss(runner.enrollment.watcherId)
    } catch (error) {
      console.warn('[heimdall] worker interval teardown failed during delete:', error)
    }
    this.releaseOwnedBudgetInterval(runner, 'shutdown')
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
    this.closeOwnedBudgetInterval(runner, 'shutdown')
    runner.status = { ...runner.status, nextPulseAtMs: null }
    this.dependencies.publish(runner)
  }

  private closeOwnedBudgetInterval(
    runner: WatcherRunner,
    reason: 'contact-lost' | 'shutdown'
  ): void {
    const openInterval = this.dependencies.budgetClock.owned(runner.enrollment.watcherId)
    if (openInterval) {
      this.dependencies.budgetClock.close(openInterval, reason)
    }
    runner.ownerBudgetInterval = null
  }

  // deletion must proceed even when the owned interval cannot be torn down
  private releaseOwnedBudgetInterval(
    runner: WatcherRunner,
    reason: 'contact-lost' | 'shutdown'
  ): void {
    const openInterval = this.dependencies.budgetClock.owned(runner.enrollment.watcherId)
    if (openInterval) {
      try {
        const budgetClock = this.dependencies.budgetClock
        if (budgetClock.release) {
          budgetClock.release(openInterval, reason)
        } else {
          budgetClock.close(openInterval, reason)
        }
      } catch (error) {
        console.warn('[heimdall] owned interval release failed during delete:', error)
      }
    }
    runner.ownerBudgetInterval = null
  }
}
