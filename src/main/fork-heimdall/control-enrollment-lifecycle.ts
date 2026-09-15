import { deriveBudgetState } from '../../shared/fork-heimdall/budget'
import type {
  WatcherCommandResult,
  WatcherOwnerFence
} from '../../shared/fork-heimdall/fleet-types'
import {
  getInFlightAttempts,
  getLatestEscalations
} from '../../shared/fork-heimdall/ledger-queries'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import type { EnrollmentControlChange, EnrollmentControlCommit } from './enrollment-store'
import type { HeimdallLedgerStore } from './ledger-store'
import type { LeaseStore } from './lease-store'
import type { WatcherRunnerLoop } from './runner-loop'
import type { WatcherRunner } from './runner-state'

export type EnrollmentControlLifecycleDependencies = {
  ledger: HeimdallLedgerStore
  lease: LeaseStore
  runnerLoop: WatcherRunnerLoop
  runner(watcherId: string): WatcherRunner | null
  commit(
    watcherId: string,
    expectedOwner: WatcherOwnerFence,
    change: EnrollmentControlChange,
    appendWithinTransaction?: () => void
  ): EnrollmentControlCommit
  requireValidCommit(commit: EnrollmentControlCommit): WatcherEnrollment
  latestHaltWasAutomaticPark(ledger: WatcherLedger): boolean
  appendOpenParkAcknowledgements(watcherId: string): void
  appendDisarmTransitions(watcherId: string): void
  now(): number
}

/** Owns persisted pause, resume, disarm, and budget transitions for one watcher. */
export class WatcherEnrollmentControlLifecycle {
  constructor(private readonly dependencies: EnrollmentControlLifecycleDependencies) {}

  async pause(
    enrollment: WatcherEnrollment,
    expectedOwner: WatcherOwnerFence
  ): Promise<WatcherCommandResult> {
    if (!enrollment.enabled || enrollment.paused) {
      return refused('invalid-state', 'Only an active watcher can be paused')
    }
    const runner = this.dependencies.runner(enrollment.watcherId)
    const commit = await this.commitAfterExecutionFence(enrollment, expectedOwner, 'pause', {
      paused: true
    })
    if (commit.status === 'refused') {
      return commit
    }
    const updated = this.dependencies.requireValidCommit(commit)
    if (runner) {
      runner.enrollment = updated
      runner.status = {
        ...runner.status,
        enabled: true,
        state: 'held',
        phase: 'paused',
        reason: 'paused',
        nextPulseAtMs: null
      }
      if (getInFlightAttempts(this.dependencies.ledger.read(updated.watcherId)).length > 0) {
        this.dependencies.runnerLoop.schedule(runner, 0)
      } else {
        const guard = runner.leaseGuard
        this.dependencies.runnerLoop.disarm(runner)
        await this.releaseRunnerLease(updated, guard)
      }
    }
    return this.applied()
  }

  resume(enrollment: WatcherEnrollment, expectedOwner: WatcherOwnerFence): WatcherCommandResult {
    const ledger = this.dependencies.ledger.read(enrollment.watcherId)
    const parked = !enrollment.enabled && this.dependencies.latestHaltWasAutomaticPark(ledger)
    if (!enrollment.paused && !parked) {
      return refused(
        'invalid-state',
        'Only a paused or automatically parked watcher can be resumed'
      )
    }
    if (deriveBudgetState(ledger, enrollment.budget).exhausted) {
      return refused('invalid-state', 'Raise the exhausted watcher budget before resuming')
    }
    if (
      getLatestEscalations(ledger).some(
        (entry) => entry.status === 'open' && entry.escalationKind === 'worker-question'
      )
    ) {
      return refused('invalid-state', 'Answer the pending worker question before resuming')
    }
    const commit = this.dependencies.commit(
      enrollment.watcherId,
      expectedOwner,
      { enabled: true, paused: false },
      () => this.dependencies.appendOpenParkAcknowledgements(enrollment.watcherId)
    )
    if (commit.status === 'refused') {
      return commit
    }
    const updated = this.dependencies.requireValidCommit(commit)
    const runner = this.dependencies.runner(updated.watcherId)
    if (runner) {
      runner.enrollment = updated
      runner.status = {
        ...runner.status,
        enabled: true,
        state: 'watching',
        phase: 'resumed',
        reason: null,
        parkReason: null
      }
      this.dependencies.runnerLoop.schedule(runner, 0)
    }
    return this.applied()
  }

  async disarm(
    enrollment: WatcherEnrollment,
    expectedOwner: WatcherOwnerFence
  ): Promise<WatcherCommandResult> {
    const ledger = this.dependencies.ledger.read(enrollment.watcherId)
    if (!enrollment.enabled && !this.dependencies.latestHaltWasAutomaticPark(ledger)) {
      return refused('invalid-state', 'The watcher is already disarmed')
    }
    const runner = this.dependencies.runner(enrollment.watcherId)
    const commit = await this.commitAfterExecutionFence(
      enrollment,
      expectedOwner,
      'disarm',
      { enabled: false, paused: false },
      () => this.dependencies.appendDisarmTransitions(enrollment.watcherId)
    )
    if (commit.status === 'refused') {
      return commit
    }
    const updated = this.dependencies.requireValidCommit(commit)
    if (runner) {
      runner.enrollment = updated
      runner.status = {
        ...runner.status,
        enabled: false,
        state: 'disabled',
        phase: 'disarmed',
        reason: null,
        parkReason: null,
        nextPulseAtMs: null
      }
      if (getInFlightAttempts(this.dependencies.ledger.read(updated.watcherId)).length === 0) {
        const guard = runner.leaseGuard
        this.dependencies.runnerLoop.disarm(runner)
        await this.releaseRunnerLease(updated, guard)
      } else {
        // The control fence swallowed the in-flight tick's own reschedule, so re-arm it here.
        this.dependencies.runnerLoop.schedule(runner, 0)
      }
    }
    return this.applied()
  }

  adjustBudget(
    enrollment: WatcherEnrollment,
    expectedOwner: WatcherOwnerFence,
    budget: WatcherEnrollment['budget']
  ): WatcherCommandResult {
    const commit = this.dependencies.commit(enrollment.watcherId, expectedOwner, { budget })
    if (commit.status === 'refused') {
      return commit
    }
    const updated = this.dependencies.requireValidCommit(commit)
    const runner = this.dependencies.runner(updated.watcherId)
    if (runner) {
      runner.enrollment = updated
      runner.status = {
        ...runner.status,
        budget: deriveBudgetState(this.dependencies.ledger.read(updated.watcherId), updated.budget)
      }
    }
    return this.applied()
  }

  private async commitAfterExecutionFence(
    enrollment: WatcherEnrollment,
    expectedOwner: WatcherOwnerFence,
    control: 'pause' | 'disarm',
    change: EnrollmentControlChange,
    appendWithinTransaction?: () => void
  ): Promise<EnrollmentControlCommit> {
    const runner = this.dependencies.runner(enrollment.watcherId)
    if (runner) {
      runner.controlPending = control
      await runner.operationTail
    }
    let committed = false
    try {
      const result = this.dependencies.commit(
        enrollment.watcherId,
        expectedOwner,
        change,
        appendWithinTransaction
      )
      committed = result.status === 'committed'
      return result
    } finally {
      if (runner?.controlPending === control) {
        runner.controlPending = null
        if (!committed && runner.enrollment.enabled && !runner.enrollment.paused) {
          this.dependencies.runnerLoop.schedule(runner, 0)
        }
      }
    }
  }

  private async releaseRunnerLease(
    enrollment: WatcherEnrollment,
    guard: WatcherRunner['leaseGuard']
  ): Promise<void> {
    if (!guard) {
      return
    }
    await this.dependencies.lease.release(enrollment.workspaceKey, guard.epoch).catch(() => {})
  }

  private applied(): WatcherCommandResult {
    return { status: 'applied', appliedAtMs: this.dependencies.now() }
  }
}

function refused(
  reason: Extract<WatcherCommandResult, { status: 'refused' }>['reason'],
  detail: string
): WatcherCommandResult {
  return { status: 'refused', reason, detail }
}
