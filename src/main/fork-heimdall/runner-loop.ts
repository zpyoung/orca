import { randomUUID } from 'node:crypto'
import { deriveBudgetState } from '../../shared/fork-heimdall/budget'
import {
  getInFlightAttempts,
  getUnresolvedAttempts,
  hasPendingAttemptOutcome
} from '../../shared/fork-heimdall/ledger-queries'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import { errorBackoffMs, HEIMDALL_RAPID_POLL_MS } from '../../shared/fork-heimdall/pacing'
import { requireLiveSnapshot, type Snapshot } from '../../shared/fork-heimdall/snapshot'
import {
  createTickTrace,
  pushTickTrace,
  type WatcherTickTrace
} from '../../shared/fork-heimdall/tick-trace'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import { dormantWatcherStatus } from './debug-report'
import { readAndRefreshJudgmentSnapshot } from './judgment/mailbox-refresh'
import type { RegisteredWatcherKind } from './registry'
import { createWatcherRunner } from './runner-factory'
import { WatcherLedgerLifecycle } from './ledger-lifecycle'
import { WatcherRunnerControlLifecycle } from './runner-control-lifecycle'
import { WatcherRunnerActions } from './runner-actions'
import { runActionLoop } from './runner-action-loop'
import { WatcherRunnerErrorLifecycle } from './runner-error-lifecycle'
import { WatcherRunnerGateLifecycle } from './runner-gating'
import { runnerPacingDelay } from './runner-pacing'
import { WatcherRunnerStopLifecycle } from './runner-stop-lifecycle'
import { WatcherRunnerStatusLifecycle } from './runner-status'
import type { WatcherRunner, WatcherRunnerDependencies } from './runner-state'
import { WatcherRunnerWorkerLifecycle } from './runner-worker-lifecycle'
import { releaseEligibleSettledWorkers, workerReleaseConfirmed } from './runner-worker-release'
import { runOwnerDeviationTick } from './owner/deviation-tick'

export class WatcherRunnerLoop {
  readonly dispatchLifecycle: WatcherLedgerLifecycle
  private readonly actions: WatcherRunnerActions
  readonly controlLifecycle: WatcherRunnerControlLifecycle
  private readonly gating: WatcherRunnerGateLifecycle
  private readonly errorLifecycle: WatcherRunnerErrorLifecycle
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
    this.gating = new WatcherRunnerGateLifecycle(
      dependencies,
      this.actions,
      () => this.now(),
      () => this.createId()
    )
    this.statusLifecycle = new WatcherRunnerStatusLifecycle({
      ledgerStore: dependencies.ledgerStore,
      persistEnabled: (runner, enabled) => dependencies.persistEnabled(runner.enrollment, enabled),
      persistTerminal: dependencies.persistTerminal,
      now: () => this.now(),
      createId: () => this.createId(),
      publish: (runner) => this.publishStatus(runner)
    })
    this.errorLifecycle = new WatcherRunnerErrorLifecycle({
      dispatchLifecycle: this.dispatchLifecycle,
      statusLifecycle: this.statusLifecycle,
      schedule: (runner, delayMs) => this.schedule(runner, delayMs),
      disarm: (runner) => this.controlLifecycle.disarm(runner),
      publish: (runner) => this.publishStatus(runner),
      releaseLease: (runner, guard) => this.releaseLeaseGuard(runner, guard)
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
    this.stopLifecycle = new WatcherRunnerStopLifecycle(this.statusLifecycle, {
      ledgerStore: dependencies.ledgerStore,
      now: () => this.now(),
      createId: () => this.createId()
    })
  }

  createRunner(enrollment: WatcherEnrollment, kind: RegisteredWatcherKind): WatcherRunner {
    return createWatcherRunner(enrollment, kind, this.dependencies.ledgerStore)
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
          await this.errorLifecycle.parkForConfigurationError(runner, lease.reason)
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
          this.resyncEnrollment(runner)
          runner.status = {
            ...dormantWatcherStatus(
              runner.enrollment,
              this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
            ),
            phase: 'lease-refused',
            reason: `Lease held by ${lease.holder} (epoch ${lease.epoch})`
          }
          this.publishStatus(runner)
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
      this.resyncEnrollment(runner)
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
      const snapshotResult = await readAndRefreshJudgmentSnapshot({
        runner,
        ledger: this.dependencies.ledgerStore.read(runner.enrollment.watcherId),
        trace,
        leaseGuard: lease.guard,
        now: () => this.now(),
        readLedger: () => this.dependencies.ledgerStore.read(runner.enrollment.watcherId),
        abandonPendingAttempts: (currentSnapshot, currentLedger) =>
          this.actions.abandonPendingAttempts(runner, currentSnapshot, currentLedger),
        refreshWorkers: () => this.workerLifecycle.refresh(runner, trace)
      })
      if (!snapshotResult) {
        return
      }
      let { snapshot, ledger } = snapshotResult
      if (trace.exitPath === 'error') {
        return
      }
      if (runner.stopped || runner.controlPending === 'delete') {
        trace.exitPath = 'watching'
        return
      }
      await releaseEligibleSettledWorkers(runner, {
        ledgerStore: this.dependencies.ledgerStore,
        orchestration: this.dependencies.orchestration,
        now: () => this.now(),
        createId: () => this.createId()
      })
      ledger = this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
      if (snapshot.freshness === 'live' && runner.kind.concurrency?.reconcile) {
        await runner.kind.concurrency.reconcile(snapshot, ledger, {
          enrollment: runner.enrollment,
          lease: lease.guard,
          stopWorker: (dispatchId) =>
            this.dependencies.orchestration.stopWorker(runner.enrollment, dispatchId),
          workerReleaseConfirmed: (dispatchId) => workerReleaseConfirmed(ledger, dispatchId)
        })
        await lease.guard.assertHeld()
        snapshot = requireLiveSnapshot(await runner.kind.read(runner.enrollment, { fresh: true }))
        await lease.guard.assertHeld()
        trace.snapshotReadCount += 1
        runner.lastSnapshot = snapshot
        runner.lastFullResyncAtMs = this.now()
        runner.forceFresh = false
        trace.snapshot = runner.kind.describeSnapshot(snapshot)
        trace.contentIdentity = snapshot.contentIdentity
        ledger = this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
      }
      const recoveredUncertainBeforeStop =
        snapshot.freshness === 'live' && getUnresolvedAttempts(ledger).length > 0
      if (recoveredUncertainBeforeStop) {
        await this.actions.recoverAttempts(runner, snapshot, ledger)
        ledger = this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
      }
      let stopped = await this.stopLifecycle.evaluate(runner, snapshot, ledger)
      if ((stopped === 'deferred' || stopped === 'parked') && snapshot.freshness === 'live') {
        if (recoveredUncertainBeforeStop) {
          this.actions.settleAbsentDispatches(runner, absentDispatches)
          ledger = this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
        } else {
          ledger = await this.actions.recoverBeforeStop(runner, snapshot, absentDispatches)
        }
        if (stopped === 'deferred') {
          stopped = await this.stopLifecycle.evaluate(runner, snapshot, ledger)
        }
      }
      if (stopped !== 'clear') {
        if (stopped === 'deferred' || hasPendingAttemptOutcome(ledger)) {
          this.schedule(runner, HEIMDALL_RAPID_POLL_MS)
        }
        trace.exitPath = 'watching'
        return
      }
      if (snapshot.freshness === 'live' && !recoveredUncertainBeforeStop) {
        await this.actions.recoverAttempts(runner, snapshot, ledger)
      }
      ledger = this.dependencies.ledgerStore.read(runner.enrollment.watcherId)

      const budget = deriveBudgetState(ledger, runner.enrollment.budget)
      trace.budget = budget
      const drainingBudget =
        budget.exhausted && (runner.kind.concurrency?.shouldDrainBudget(snapshot, ledger) ?? false)
      if (budget.exhausted && !drainingBudget) {
        this.actions.settleAbsentDispatches(runner, absentDispatches)
        ledger = this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
        this.statusLifecycle.park(runner, { kind: 'budget', exhaustion: budget.exhausted })
        trace.exitPath = 'budget-exhausted'
        if (hasPendingAttemptOutcome(ledger)) {
          this.schedule(runner, HEIMDALL_RAPID_POLL_MS)
        }
        return
      }
      // owner-driving runs before the enabled/paused checks below: a worker-question or
      // worker-escalation deviation already disabled the watcher earlier this tick (via `park`),
      // so gating this on `enabled` would make its own deviation unreachable the same way a park
      // predicate's used to be. `driveOwnerDeviation` excludes paused watchers itself.
      if (await this.driveOwner(runner, snapshot)) {
        trace.exitPath = 'gate-held'
        this.publishStatus(runner)
        this.schedule(runner, HEIMDALL_RAPID_POLL_MS)
        return
      }
      if (!runner.enrollment.enabled) {
        this.actions.settleAbsentDispatches(runner, absentDispatches)
        ledger = this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
        trace.exitPath = 'watching'
        // resync above may have picked up a durable disable written elsewhere this tick, so the
        // published status must be recomputed from it, not the runner's stale in-memory cache
        runner.status = dormantWatcherStatus(runner.enrollment, ledger)
        this.publishStatus(runner)
        // Disabled watchers keep reconciling already-authorized work whose outcome is still pending.
        if (hasPendingAttemptOutcome(ledger)) {
          this.schedule(runner, HEIMDALL_RAPID_POLL_MS)
        }
        return
      }
      // paused must still reach here (stop-policy + recovery already ran above), but must not
      // reach gating: `commitGate` also holds on `paused` too, which would record a gate-hold that
      // never happened before this fix. Status and rescheduling are already `refresh`'s from
      // earlier this tick; nothing since has touched either.
      if (runner.enrollment.paused) {
        trace.exitPath = 'gate-held'
        return
      }

      await runActionLoop({
        runner,
        snapshot,
        ledger,
        recoverableDispatches: absentDispatches,
        trace,
        gating: this.gating,
        actions: this.actions,
        statusLifecycle: this.statusLifecycle,
        stopLifecycle: this.stopLifecycle,
        ledgerStore: this.dependencies.ledgerStore,
        schedule: (activeRunner, delayMs) => this.schedule(activeRunner, delayMs),
        publishStatus: (activeRunner) => this.publishStatus(activeRunner),
        scheduleFromPacing: (activeRunner, activeSnapshot, activeLedger, activeTrace) =>
          this.scheduleFromPacing(activeRunner, activeSnapshot, activeLedger, activeTrace)
      })
    } catch (error) {
      releaseAtEnd = await this.errorLifecycle.handle(runner, error, trace, tickLease)
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

  /**
   * Keeps the runner's cached enrollment, and the status published from it, from outliving a
   * durable enable/disable/pause written elsewhere, whichever path the rest of the tick takes.
   */
  private resyncEnrollment(runner: WatcherRunner): void {
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
    this.publishStatus(runner)
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

  private driveOwner(runner: WatcherRunner, snapshot: Snapshot<unknown>): Promise<boolean> {
    const { dependencies, actions, statusLifecycle } = this
    return runOwnerDeviationTick({ dependencies, actions, statusLifecycle, runner, snapshot })
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
