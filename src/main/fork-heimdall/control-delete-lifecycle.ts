import type {
  WatcherCommandResult,
  WatcherOwnerFence
} from '../../shared/fork-heimdall/fleet-types'
import type { EnrollmentRecord, EnrollmentStore } from './enrollment-store'
import type { LeaseStore } from './lease-store'
import type { WatcherRunnerControlLifecycle } from './runner-control-lifecycle'
import type { WatcherRunner } from './runner-state'

export type WatcherDeletionDependencies = {
  enrollments: EnrollmentStore
  lease: LeaseStore
  runnerControl: WatcherRunnerControlLifecycle
  runner(watcherId: string): WatcherRunner | null
  removeRunner(watcherId: string): void
  purgeKindData(enrollment: EnrollmentRecord): Promise<void>
  owns(enrollment: EnrollmentRecord): boolean
  now(): number
  changed(): void
}

/** Permanently removes one owner-fenced watcher after its local scheduler is quiescent. */
export class WatcherDeletionLifecycle {
  constructor(private readonly dependencies: WatcherDeletionDependencies) {}

  async delete(watcherId: string, expectedOwner: WatcherOwnerFence): Promise<WatcherCommandResult> {
    const initial = this.precondition(watcherId, expectedOwner)
    if ('status' in initial) {
      return initial
    }
    const runner = this.dependencies.runner(watcherId)
    const deleteFence = runner ? this.dependencies.runnerControl.beginDelete(runner) : null
    let deleted = false
    let removeStarted = false
    try {
      if (runner) {
        await runner.operationTail
      }
      const fenced = this.precondition(watcherId, expectedOwner)
      if ('status' in fenced) {
        return fenced
      }
      const leaseGuard = runner?.leaseGuard ?? null
      if (runner) {
        removeStarted = true
        this.dependencies.runnerControl.remove(runner)
      }
      if (leaseGuard) {
        await this.dependencies.lease
          .release(fenced.enrollment.workspaceKey, leaseGuard.holder, leaseGuard.epoch)
          .catch(() => {})
      }
      const commit = this.dependencies.enrollments.deleteWatcher(watcherId, expectedOwner)
      if (commit.status === 'refused') {
        return refused(commit.reason, commit.detail)
      }
      this.dependencies.removeRunner(watcherId)
      deleted = true
      this.dependencies.changed()
      await this.dependencies.purgeKindData(fenced.enrollment)
      this.dependencies.enrollments.completeKindPurge(watcherId)
      return { status: 'applied', appliedAtMs: this.dependencies.now() }
    } catch (error) {
      // once remove() has torn the runner down, surface the failure as a refusal instead of
      // letting it propagate and rollbackDelete re-arm a runner that is no longer intact
      if (removeStarted && !deleted) {
        return refused('invalid-state', errorDetail(error))
      }
      throw error
    } finally {
      if (runner && deleteFence && !deleted && !removeStarted) {
        this.dependencies.runnerControl.rollbackDelete(runner, deleteFence)
      }
    }
  }

  private precondition(
    watcherId: string,
    expectedOwner: WatcherOwnerFence
  ): { enrollment: EnrollmentRecord } | WatcherCommandResult {
    const record = this.dependencies.enrollments.get(watcherId)
    if (!record) {
      return refused('watcher-not-found', `Heimdall watcher ${watcherId} was not found`)
    }
    if (!this.dependencies.owns(record)) {
      return refused('owner-conflict', `This process does not own Heimdall watcher ${watcherId}`)
    }
    if (
      record.executionHostId !== expectedOwner.executionHostId ||
      record.schedulerOwner !== expectedOwner.schedulerOwner ||
      record.workspaceKey !== expectedOwner.workspaceKey
    ) {
      return refused('owner-conflict', `Heimdall watcher ${watcherId} changed owner`)
    }
    if (record.commandRevision !== expectedOwner.revision) {
      return refused(
        'stale-revision',
        `Heimdall watcher ${watcherId} advanced to revision ${record.commandRevision}`
      )
    }
    return { enrollment: record }
  }
}

function refused(
  reason: Extract<WatcherCommandResult, { status: 'refused' }>['reason'],
  detail: string
): WatcherCommandResult {
  return { status: 'refused', reason, detail }
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
