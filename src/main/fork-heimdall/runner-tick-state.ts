import { requireLiveSnapshot, type Snapshot } from '../../shared/fork-heimdall/snapshot'
import type { WatcherTickTrace } from '../../shared/fork-heimdall/tick-trace'
import { dormantWatcherStatus } from './debug-report'
import type { WatcherRunner, WatcherRunnerDependencies } from './runner-state'

export class WatcherRunnerTickState {
  constructor(private readonly dependencies: WatcherRunnerDependencies) {}

  async readFreshSnapshot(
    runner: WatcherRunner,
    trace: WatcherTickTrace,
    leaseGuard: NonNullable<WatcherRunner['leaseGuard']>
  ): Promise<Snapshot<unknown>> {
    await leaseGuard.assertHeld()
    const snapshot = requireLiveSnapshot(await runner.kind.read(runner.enrollment, { fresh: true }))
    await leaseGuard.assertHeld()
    trace.snapshotReadCount += 1
    runner.lastSnapshot = snapshot
    runner.lastFullResyncAtMs = this.dependencies.now?.() ?? Date.now()
    runner.forceFresh = false
    trace.snapshot = runner.kind.describeSnapshot(snapshot)
    trace.contentIdentity = snapshot.contentIdentity
    return snapshot
  }

  /**
   * Keeps the runner's cached enrollment, and the status published from it, from outliving a
   * durable enable/disable/pause written elsewhere, whichever path the rest of the tick takes.
   */
  resyncEnrollment(runner: WatcherRunner): void {
    const savedEnrollment = this.dependencies.readEnrollment(runner.enrollment.watcherId)
    if (!savedEnrollment) {
      return
    }
    const controlChanged =
      savedEnrollment.enabled !== runner.enrollment.enabled ||
      savedEnrollment.paused !== runner.enrollment.paused
    runner.enrollment = savedEnrollment
    if (!controlChanged) {
      return
    }
    runner.status = {
      ...dormantWatcherStatus(
        savedEnrollment,
        this.dependencies.ledgerStore.read(savedEnrollment.watcherId)
      ),
      lastSuccessfulTickAtMs: runner.status.lastSuccessfulTickAtMs,
      nextPulseAtMs: runner.status.nextPulseAtMs
    }
    this.dependencies.onStatus?.(runner.status)
  }

  async releaseLeaseGuard(
    runner: WatcherRunner,
    guard: NonNullable<WatcherRunner['leaseGuard']>
  ): Promise<void> {
    if (runner.leaseGuard === guard) {
      runner.leaseRenewal?.dispose()
      runner.leaseRenewal = null
    }
    await this.dependencies.leaseStore
      .release(runner.enrollment.workspaceKey, guard.holder, guard.epoch)
      .catch(() => {})
    if (runner.leaseGuard === guard) {
      runner.leaseGuard = null
    }
  }
}
