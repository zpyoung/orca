import { randomUUID } from 'node:crypto'
import { deriveBudgetState } from '../../shared/fork-heimdall/budget'
import {
  getInFlightAttempts,
  getLastDecidedContentIdentity,
  getUnresolvedAttempts
} from '../../shared/fork-heimdall/ledger-queries'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import {
  errorBackoffMs,
  HEIMDALL_FULL_RESYNC_MS,
  HEIMDALL_RAPID_POLL_MS
} from '../../shared/fork-heimdall/pacing'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import {
  createTickTrace,
  pushTickTrace,
  type WatcherTickTrace
} from '../../shared/fork-heimdall/tick-trace'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import { dormantWatcherStatus } from './debug-report'
import type { RegisteredWatcherKind } from './registry'
import { WatcherLedgerLifecycle } from './ledger-lifecycle'
import { WatcherRunnerControlLifecycle } from './runner-control-lifecycle'
import { errorText, WatcherRunnerActions } from './runner-actions'
import { WatcherRunnerGateLifecycle } from './runner-gating'
import { runnerPacingDelay } from './runner-pacing'
import { WatcherRunnerStopLifecycle } from './runner-stop-lifecycle'
import { isCoordinatorSeatLost, WatcherRunnerStatusLifecycle } from './runner-status'
import type { WatcherRunner, WatcherRunnerDependencies } from './runner-state'
import { WatcherRunnerWorkerLifecycle } from './runner-worker-lifecycle'

export class WatcherRunnerLoop {
  readonly dispatchLifecycle: WatcherLedgerLifecycle
  private readonly actions: WatcherRunnerActions
  private readonly controlLifecycle: WatcherRunnerControlLifecycle
  private readonly gating: WatcherRunnerGateLifecycle
  private readonly statusLifecycle: WatcherRunnerStatusLifecycle
  private readonly stopLifecycle: WatcherRunnerStopLifecycle
  private readonly workerLifecycle: WatcherRunnerWorkerLifecycle

  constructor(private readonly dependencies: WatcherRunnerDependencies) {
    this.dispatchLifecycle = new WatcherLedgerLifecycle({
      ledgerStore: dependencies.ledgerStore,
      budgetClock: dependencies.budgetClock,
      adapter: dependencies.orchestration,
      ...(dependencies.now ? { now: dependencies.now } : {}),
      ...(dependencies.createId ? { createId: dependencies.createId } : {})
    })
    this.actions = new WatcherRunnerActions({
      ledgerStore: dependencies.ledgerStore,
      budgetClock: dependencies.budgetClock,
      orchestration: dependencies.orchestration,
      dispatchLifecycle: this.dispatchLifecycle,
      ...(dependencies.notifyApproval ? { notifyApproval: dependencies.notifyApproval } : {}),
      now: () => this.now(),
      createId: () => this.createId()
    })
    this.controlLifecycle = new WatcherRunnerControlLifecycle({
      budgetClock: dependencies.budgetClock,
      dispatchLifecycle: this.dispatchLifecycle,
      schedule: (runner, delayMs) => this.schedule(runner, delayMs),
      clearTimer: (timer) => this.clearTimer(timer),
      publish: (runner) => this.publishStatus(runner)
    })
    this.gating = new WatcherRunnerGateLifecycle(dependencies, this.actions)
    this.statusLifecycle = new WatcherRunnerStatusLifecycle({
      ledgerStore: dependencies.ledgerStore,
      persistEnabled: (runner, enabled) => dependencies.persistEnabled(runner.enrollment, enabled),
      persistTerminal: dependencies.persistTerminal,
      now: () => this.now(),
      createId: () => this.createId(),
      publish: (runner) => this.publishStatus(runner)
    })
    this.workerLifecycle = new WatcherRunnerWorkerLifecycle({
      ledgerStore: dependencies.ledgerStore,
      orchestration: dependencies.orchestration,
      dispatchLifecycle: this.dispatchLifecycle,
      statusLifecycle: this.statusLifecycle,
      schedule: (runner, delayMs) => this.schedule(runner, delayMs),
      publish: (runner) => this.publishStatus(runner),
      now: () => this.now(),
      createId: () => this.createId()
    })
    this.stopLifecycle = new WatcherRunnerStopLifecycle(this.statusLifecycle)
  }

  createRunner(enrollment: WatcherEnrollment, kind: RegisteredWatcherKind): WatcherRunner {
    const ledger = this.dependencies.ledgerStore.read(enrollment.watcherId)
    const traces = this.dependencies.ledgerStore.readTickTraces(enrollment.watcherId)
    return {
      enrollment,
      kind,
      status: dormantWatcherStatus(
        enrollment,
        ledger,
        this.dependencies.ledgerStore.readTerminalSummary(enrollment.watcherId)
      ),
      timer: null,
      operationTail: Promise.resolve(),
      tickQueued: false,
      reconcileAgain: false,
      stopped: enrollment.terminalAtMs !== null,
      suspended: false,
      recovered: false,
      controlPending: null,
      forceFresh: false,
      consecutiveErrors: 0,
      consecutiveGateHolds: 0,
      lastFullResyncAtMs: null,
      lastSnapshot: null,
      traceSequence: traces.at(-1)?.seq ?? 0,
      traces,
      leaseGuard: null,
      leaseRenewal: null
    }
  }

  schedule(runner: WatcherRunner, delayMs: number): void {
    if (runner.stopped || runner.suspended || runner.controlPending !== null) {
      return
    }
    if (runner.timer) {
      this.clearTimer(runner.timer)
    }
    const safeDelay = Math.max(0, delayMs)
    runner.status = { ...runner.status, nextPulseAtMs: this.now() + safeDelay }
    this.publishStatus(runner)
    runner.timer = this.setTimer(() => {
      runner.timer = null
      void this.pulse(runner).catch((error) => {
        console.warn('[heimdall] watcher pulse failed:', error)
      })
    }, safeDelay)
    runner.timer.unref?.()
  }

  pulse(runner: WatcherRunner): Promise<void> {
    if (runner.tickQueued) {
      runner.reconcileAgain = true
      return runner.operationTail
    }
    runner.tickQueued = true
    const operation = runner.operationTail.then(() =>
      this.tick(runner as WatcherRunner & { kind: RegisteredWatcherKind })
    )
    runner.operationTail = operation.then(
      () => undefined,
      () => undefined
    )
    return operation.finally(() => {
      runner.tickQueued = false
      if (runner.reconcileAgain && !runner.stopped && !runner.suspended) {
        runner.reconcileAgain = false
        this.schedule(runner, 0)
      }
    })
  }

  suspend(runner: WatcherRunner): void {
    this.controlLifecycle.suspend(runner)
  }

  resume(runner: WatcherRunner): void {
    this.controlLifecycle.resume(runner)
  }

  disarm(runner: WatcherRunner): void {
    this.controlLifecycle.disarm(runner)
  }

  acknowledgePark(watcherId: string): void {
    this.actions.acknowledgePark(watcherId)
  }

  stop(runner: WatcherRunner): void {
    this.controlLifecycle.stop(runner)
  }

  private async tick(runner: WatcherRunner): Promise<void> {
    if (runner.stopped || runner.suspended) {
      return
    }
    runner.traceSequence += 1
    const startedAtMs = this.now()
    const trace = createTickTrace(runner.traceSequence, startedAtMs, {
      consecutiveErrors: runner.consecutiveErrors,
      lastFullResyncAtMs: runner.lastFullResyncAtMs,
      reconcileAgain: runner.reconcileAgain
    })
    pushTickTrace(runner.traces, trace)
    let releaseAtEnd = false
    let tickLease: NonNullable<WatcherRunner['leaseGuard']> | null = null
    try {
      const lease = await this.dependencies.leaseStore.acquireOrRenew(
        runner.enrollment.workspaceKey,
        this.dependencies.holderId,
        this.dependencies.leaseTtlMs ?? 90_000
      )
      if (lease.status !== 'held') {
        if (lease.status === 'configuration-error') {
          trace.exitPath = 'error'
          trace.error = { message: lease.reason }
          await this.parkForConfigurationError(runner, lease.reason)
          return
        }
        trace.exitPath = lease.status === 'refused' ? 'lease-refused' : 'lease-unverifiable'
        if (lease.status === 'unverifiable') {
          this.dependencies.ledgerStore.append(runner.enrollment.watcherId, {
            eventId: this.createId(),
            watcherId: runner.enrollment.watcherId,
            atMs: this.now(),
            origin: 'client',
            class: 'observation',
            kind: 'client-observation',
            what: 'lease-unverifiable',
            detail: lease.reason
          })
          this.dispatchLifecycle.closeForContactLoss(runner.enrollment.watcherId)
          trace.error = { message: lease.reason }
          runner.consecutiveErrors += 1
          runner.status = {
            ...runner.status,
            state: 'unreachable',
            phase: 'lease-unverifiable',
            reason: lease.reason,
            nextPulseAtMs: null
          }
          this.publishStatus(runner)
          this.schedule(runner, errorBackoffMs(runner.consecutiveErrors) ?? HEIMDALL_RAPID_POLL_MS)
        } else {
          this.schedule(runner, HEIMDALL_RAPID_POLL_MS)
        }
        return
      }
      tickLease = lease.guard
      trace.leaseEpoch = lease.epoch
      releaseAtEnd = true
      if (runner.stopped || runner.suspended) {
        trace.exitPath = 'watching'
        return
      }
      runner.leaseRenewal?.dispose()
      runner.leaseGuard = lease.guard
      runner.leaseRenewal = lease.guard.renewLoop()

      if (!runner.recovered) {
        this.dependencies.budgetClock.recoverOnStart(runner.enrollment.watcherId)
        runner.recovered = true
      }
      const absentDispatches = await this.dispatchLifecycle.recover(runner.enrollment, lease.guard)
      if (this.dependencies.budgetClock.current?.(runner.enrollment.watcherId)) {
        this.dependencies.budgetClock.checkpoint(runner.enrollment.watcherId)
      }

      let ledger = this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
      const unresolvedNeedsAuthority = getUnresolvedAttempts(ledger).length > 0
      const fullResyncDue =
        runner.forceFresh ||
        unresolvedNeedsAuthority ||
        runner.lastFullResyncAtMs === null ||
        this.now() - runner.lastFullResyncAtMs >= HEIMDALL_FULL_RESYNC_MS
      trace.fullResyncDue = fullResyncDue
      let snapshot = await runner.kind.read(runner.enrollment, { fresh: fullResyncDue })
      await lease.guard.assertHeld()
      trace.snapshotReadCount += 1
      if (fullResyncDue && snapshot.freshness !== 'live') {
        throw new Error('A fresh watcher read returned a cached snapshot')
      }
      if (snapshot.freshness === 'live') {
        runner.lastFullResyncAtMs = this.now()
        runner.forceFresh = false
      }
      runner.lastSnapshot = snapshot
      trace.snapshot = runner.kind.describeSnapshot(snapshot)
      trace.contentIdentity = snapshot.contentIdentity

      const previousIdentity = getLastDecidedContentIdentity(ledger)
      if (previousIdentity && previousIdentity !== snapshot.contentIdentity) {
        this.actions.abandonPendingAttempts(runner, ledger)
        ledger = this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
      }

      const refreshedLedger = await this.workerLifecycle.refresh(runner, trace)
      if (!refreshedLedger) {
        return
      }
      ledger = refreshedLedger

      let stopped = await this.stopLifecycle.evaluate(runner, snapshot, ledger)
      if ((stopped === 'deferred' || stopped === 'parked') && snapshot.freshness === 'live') {
        ledger = await this.actions.recoverBeforeStop(runner, snapshot, absentDispatches)
        if (stopped === 'deferred') {
          stopped = await this.stopLifecycle.evaluate(runner, snapshot, ledger)
        }
      }
      if (stopped !== 'clear') {
        if (stopped === 'deferred' || getInFlightAttempts(ledger).length > 0) {
          this.schedule(runner, HEIMDALL_RAPID_POLL_MS)
        }
        trace.exitPath = 'watching'
        return
      }
      if (snapshot.freshness === 'live') {
        await this.actions.recoverAttempts(runner, snapshot, ledger)
      }
      ledger = this.dependencies.ledgerStore.read(runner.enrollment.watcherId)

      const budget = deriveBudgetState(ledger, runner.enrollment.budget)
      trace.budget = budget
      if (budget.exhausted) {
        this.actions.settleAbsentDispatches(runner, absentDispatches)
        ledger = this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
        this.statusLifecycle.park(runner, { kind: 'budget', exhaustion: budget.exhausted })
        trace.exitPath = 'budget-exhausted'
        if (getInFlightAttempts(ledger).length > 0) {
          this.schedule(runner, HEIMDALL_RAPID_POLL_MS)
        }
        return
      }
      if (!runner.enrollment.enabled) {
        this.actions.settleAbsentDispatches(runner, absentDispatches)
        ledger = this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
        trace.exitPath = 'watching'
        this.publishStatus(runner)
        // a disarm with work still in flight keeps polling so the finally can release the lease
        if (getInFlightAttempts(ledger).length > 0) {
          this.schedule(runner, HEIMDALL_RAPID_POLL_MS)
        }
        return
      }

      const gateEvaluation = await this.gating.evaluate(
        runner,
        snapshot,
        ledger,
        absentDispatches,
        trace
      )
      snapshot = gateEvaluation.snapshot
      if (gateEvaluation.outcome === 'watching') {
        trace.exitPath = 'watching'
        if (gateEvaluation.immediate) {
          this.schedule(runner, 0)
        } else {
          this.scheduleFromPacing(runner, snapshot, gateEvaluation.ledger, trace)
        }
        if (gateEvaluation.successful) {
          this.statusLifecycle.markSuccessful(runner, 'watching')
        }
        return
      }
      if (gateEvaluation.outcome === 'gated') {
        this.actions.recordGateRejection(runner, gateEvaluation.action, gateEvaluation.gate)
        trace.exitPath = gateEvaluation.gate.verdict === 'escalate' ? 'gate-escalated' : 'gate-held'
        this.statusLifecycle.gate(
          runner,
          gateEvaluation.gate.verdict === 'escalate',
          gateEvaluation.gate.reason
        )
        runner.consecutiveGateHolds += 1
        this.scheduleFromPacing(
          runner,
          snapshot,
          this.dependencies.ledgerStore.read(runner.enrollment.watcherId),
          trace
        )
        return
      }

      const executed = await this.actions.execute(
        runner,
        snapshot,
        gateEvaluation.action,
        gateEvaluation.recoveredAttempt
      )
      if (!executed) {
        trace.exitPath = 'gate-held'
        return
      }
      trace.exitPath = 'acted'
      ledger = this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
      if (runner.enrollment.paused) {
        runner.status = {
          ...runner.status,
          enabled: true,
          state: 'held',
          phase: 'paused',
          reason: 'paused',
          nextPulseAtMs: null
        }
        this.publishStatus(runner)
        if (getInFlightAttempts(ledger).length > 0) {
          this.schedule(runner, HEIMDALL_RAPID_POLL_MS)
        }
        return
      }
      if (!runner.enrollment.enabled) {
        runner.status = {
          ...runner.status,
          enabled: false,
          state: 'disabled',
          phase: 'disarmed',
          reason: null,
          parkReason: null,
          nextPulseAtMs: null
        }
        this.publishStatus(runner)
        if (getInFlightAttempts(ledger).length > 0) {
          this.schedule(runner, HEIMDALL_RAPID_POLL_MS)
        }
        return
      }
      this.statusLifecycle.markSuccessful(runner, 'acting')
      const afterStop = await this.stopLifecycle.evaluate(runner, snapshot, ledger)
      if (afterStop === 'clear' || afterStop === 'deferred') {
        // The next decision is a pure function of the ledger and the snapshot, and attempt
        // fingerprints stop a settled action being retried, so waiting only adds latency.
        this.schedule(runner, 0)
      }
    } catch (error) {
      this.dispatchLifecycle.closeForContactLoss(runner.enrollment.watcherId)
      if (isCoordinatorSeatLost(error)) {
        trace.exitPath = 'gate-escalated'
        trace.error = null
        this.statusLifecycle.park(runner, { kind: 'coordinator-seat-lost' })
        if (tickLease) {
          await this.releaseLeaseGuard(runner, tickLease)
        }
        releaseAtEnd = false
        return
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
      this.publishStatus(runner)
      this.schedule(runner, errorBackoffMs(runner.consecutiveErrors) ?? HEIMDALL_RAPID_POLL_MS)
    } finally {
      trace.durationMs = Math.max(0, this.now() - startedAtMs)
      if (trace.exitPath === null) {
        trace.exitPath = 'error'
      }
      trace.pinned =
        getUnresolvedAttempts(this.dependencies.ledgerStore.read(runner.enrollment.watcherId))
          .length > 0
      if (runner.enrollment.terminalAtMs === null) {
        this.dependencies.ledgerStore.appendTickTrace(runner.enrollment.watcherId, trace)
      }
      if (releaseAtEnd) {
        const running = getInFlightAttempts(
          this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
        ).some((attempt) => attempt.state === 'running')
        if ((!running || runner.stopped || runner.suspended) && tickLease) {
          await this.releaseLeaseGuard(runner, tickLease)
        }
      }
    }
  }

  private async parkForConfigurationError(runner: WatcherRunner, reason: string): Promise<void> {
    const retainedGuard = runner.leaseGuard
    this.statusLifecycle.configurationError(runner, reason)
    if (retainedGuard) {
      await this.releaseLeaseGuard(runner, retainedGuard)
    }
    this.controlLifecycle.disarm(runner)
    runner.reconcileAgain = false
  }

  private async releaseLeaseGuard(
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

  private scheduleFromPacing(
    runner: WatcherRunner,
    snapshot: Snapshot<unknown>,
    ledger: WatcherLedger,
    trace: WatcherTickTrace
  ): void {
    const delayMs = runnerPacingDelay(runner, snapshot, ledger, trace, this.now())
    if (delayMs !== null) {
      this.schedule(runner, delayMs)
    }
  }

  private publishStatus(runner: WatcherRunner): void {
    this.dependencies.onStatus?.(runner.status)
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now()
  }

  private createId(): string {
    return this.dependencies.createId?.() ?? randomUUID()
  }

  private setTimer(callback: () => void, delayMs: number): NodeJS.Timeout {
    return (this.dependencies.setTimer ?? setTimeout)(callback, delayMs)
  }

  private clearTimer(timer: NodeJS.Timeout): void {
    ;(this.dependencies.clearTimer ?? clearTimeout)(timer)
  }
}
