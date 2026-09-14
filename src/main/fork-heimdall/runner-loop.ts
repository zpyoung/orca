import { randomUUID } from 'node:crypto'
import { deriveBudgetState } from '../../shared/fork-heimdall/budget'
import {
  getInFlightAttempts,
  getLastDecidedContentIdentity,
  getUnresolvedAttempts
} from '../../shared/fork-heimdall/ledger-queries'
import type { LedgerEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import {
  derivePacing,
  errorBackoffMs,
  HEIMDALL_FULL_RESYNC_MS,
  HEIMDALL_RAPID_POLL_MS
} from '../../shared/fork-heimdall/pacing'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import { evaluateStopPredicates } from '../../shared/fork-heimdall/stop-policy'
import {
  createTickTrace,
  pushTickTrace,
  type WatcherTickTrace
} from '../../shared/fork-heimdall/tick-trace'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import type { RegisteredWatcherKind } from './registry'
import { WatcherLedgerLifecycle } from './ledger-lifecycle'
import { errorText, WatcherRunnerActions } from './runner-actions'
import { WatcherRunnerGateLifecycle } from './runner-gating'
import { isCoordinatorSeatLost, WatcherRunnerStatusLifecycle } from './runner-status'
import type { WatcherRunner, WatcherRunnerDependencies } from './runner-state'

export class WatcherRunnerLoop {
  readonly dispatchLifecycle: WatcherLedgerLifecycle
  private readonly actions: WatcherRunnerActions
  private readonly gating: WatcherRunnerGateLifecycle
  private readonly statusLifecycle: WatcherRunnerStatusLifecycle

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
    this.gating = new WatcherRunnerGateLifecycle(dependencies, this.actions)
    this.statusLifecycle = new WatcherRunnerStatusLifecycle({
      ledgerStore: dependencies.ledgerStore,
      persistEnabled: (runner, enabled) => dependencies.persistEnabled(runner.enrollment, enabled),
      now: () => this.now(),
      createId: () => this.createId(),
      publish: (runner) => this.publishStatus(runner)
    })
  }

  createRunner(enrollment: WatcherEnrollment, kind: RegisteredWatcherKind): WatcherRunner {
    const now = this.now()
    const traces = this.dependencies.ledgerStore.readTickTraces(enrollment.watcherId)
    return {
      enrollment,
      kind,
      status: {
        watcherId: enrollment.watcherId,
        enabled: enrollment.enabled,
        state: enrollment.enabled ? 'watching' : 'disabled',
        phase: 'starting',
        reason: null,
        parkReason: null,
        budget: deriveBudgetState(
          this.dependencies.ledgerStore.read(enrollment.watcherId),
          enrollment.budget
        ),
        startedAtMs: now,
        lastSuccessfulTickAtMs: null,
        nextPulseAtMs: null
      },
      timer: null,
      operationTail: Promise.resolve(),
      tickQueued: false,
      reconcileAgain: false,
      stopped: false,
      suspended: false,
      recovered: false,
      forceFresh: false,
      consecutiveErrors: 0,
      lastFullResyncAtMs: null,
      lastSnapshot: null,
      traceSequence: traces.at(-1)?.seq ?? 0,
      traces,
      leaseGuard: null,
      leaseRenewal: null
    }
  }

  schedule(runner: WatcherRunner, delayMs: number): void {
    if (runner.stopped || runner.suspended) {
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
    runner.suspended = true
    runner.forceFresh = true
    if (runner.timer) {
      this.clearTimer(runner.timer)
      runner.timer = null
    }
    this.dispatchLifecycle.closeForContactLoss(runner.enrollment.watcherId)
    const openInterval =
      this.dependencies.budgetClock.current?.(runner.enrollment.watcherId) ?? null
    if (openInterval) {
      this.dependencies.budgetClock.close(openInterval, 'contact-lost')
    }
    runner.status = { ...runner.status, phase: 'suspended', nextPulseAtMs: null }
    this.publishStatus(runner)
  }

  resume(runner: WatcherRunner): void {
    if (runner.stopped) {
      return
    }
    runner.suspended = false
    runner.forceFresh = true
    this.schedule(runner, 0)
  }
  disarm(runner: WatcherRunner): void {
    if (runner.timer) {
      this.clearTimer(runner.timer)
    }
    runner.timer = null
    runner.leaseRenewal?.dispose()
    runner.leaseRenewal = null
    runner.leaseGuard = null
    runner.status = { ...runner.status, nextPulseAtMs: null }
    this.publishStatus(runner)
  }

  acknowledgePark(watcherId: string): void {
    this.actions.acknowledgePark(watcherId)
  }

  stop(runner: WatcherRunner): void {
    runner.stopped = true
    if (runner.timer) {
      this.clearTimer(runner.timer)
    }
    runner.timer = null
    runner.leaseRenewal?.dispose()
    runner.leaseRenewal = null
    this.dispatchLifecycle.closeForShutdown()
    const openInterval =
      this.dependencies.budgetClock.current?.(runner.enrollment.watcherId) ?? null
    if (openInterval) {
      this.dependencies.budgetClock.close(openInterval, 'shutdown')
    }
    runner.status = { ...runner.status, nextPulseAtMs: null }
    this.publishStatus(runner)
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
    try {
      const lease = await this.dependencies.leaseStore.acquireOrRenew(
        runner.enrollment.workspaceKey,
        this.dependencies.holderId,
        this.dependencies.leaseTtlMs ?? 90_000
      )
      if (lease.status !== 'held') {
        trace.exitPath = lease.status === 'refused' ? 'lease-refused' : 'lease-unverifiable'
        if (lease.status === 'unverifiable') {
          this.append(runner, {
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
      runner.leaseRenewal?.dispose()
      runner.leaseGuard = lease.guard
      runner.leaseRenewal = lease.guard.renewLoop()
      trace.leaseEpoch = lease.epoch
      releaseAtEnd = true

      if (!runner.recovered) {
        this.dependencies.budgetClock.recoverOnStart(runner.enrollment.watcherId)
        runner.recovered = true
      }
      const absentDispatches = await this.dispatchLifecycle.recover(runner.enrollment)
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

      const workerState = await this.actions.reconcileWorkers(runner)
      ledger = this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
      if (workerState.status === 'question') {
        this.statusLifecycle.park(runner, {
          kind: 'worker-question',
          messageId: workerState.messageId
        })
        trace.exitPath = 'gate-held'
        this.schedule(runner, HEIMDALL_RAPID_POLL_MS)
        return
      }
      if (workerState.status === 'unverifiable') {
        trace.error = { message: workerState.reason }
        runner.consecutiveErrors += 1
        runner.status = {
          ...runner.status,
          state: 'unreachable',
          phase: 'worker-unverifiable',
          reason: workerState.reason,
          nextPulseAtMs: null
        }
        this.publishStatus(runner)
        trace.exitPath = 'error'
        this.schedule(runner, errorBackoffMs(runner.consecutiveErrors) ?? HEIMDALL_RAPID_POLL_MS)
        return
      }
      if (workerState.status === 'exited') {
        runner.forceFresh = true
        trace.exitPath = 'watching'
        this.schedule(runner, 0)
        return
      }

      const stopped = evaluateStopPredicates(runner.kind.stopPredicates ?? [], snapshot, ledger)
      if (stopped) {
        this.statusLifecycle.park(runner, {
          kind: 'stop-predicate',
          predicateId: stopped.predicateId,
          reason: stopped.reason
        })
        trace.exitPath = 'watching'
        return
      }
      if (snapshot.freshness === 'live') {
        this.actions.resolveUncertainAttempts(runner, snapshot, ledger)
      }
      ledger = this.dependencies.ledgerStore.read(runner.enrollment.watcherId)

      const budget = deriveBudgetState(ledger, runner.enrollment.budget)
      trace.budget = budget
      if (budget.exhausted) {
        this.statusLifecycle.park(runner, { kind: 'budget', exhaustion: budget.exhausted })
        trace.exitPath = 'budget-exhausted'
        if (getInFlightAttempts(ledger).length > 0) {
          this.schedule(runner, HEIMDALL_RAPID_POLL_MS)
        }
        return
      }
      if (!runner.enrollment.enabled) {
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
        this.scheduleFromPacing(
          runner,
          snapshot,
          this.dependencies.ledgerStore.read(runner.enrollment.watcherId),
          trace
        )
        return
      }

      await this.actions.execute(
        runner,
        snapshot,
        gateEvaluation.action,
        gateEvaluation.recoveredAttempt
      )
      trace.exitPath = 'acted'
      this.statusLifecycle.markSuccessful(runner, 'acting')
      ledger = this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
      const afterStop = evaluateStopPredicates(runner.kind.stopPredicates ?? [], snapshot, ledger)
      if (afterStop) {
        this.statusLifecycle.park(runner, {
          kind: 'stop-predicate',
          predicateId: afterStop.predicateId,
          reason: afterStop.reason
        })
      } else {
        this.schedule(runner, HEIMDALL_RAPID_POLL_MS)
      }
    } catch (error) {
      this.dispatchLifecycle.closeForContactLoss(runner.enrollment.watcherId)
      if (isCoordinatorSeatLost(error)) {
        trace.exitPath = 'gate-escalated'
        trace.error = null
        this.statusLifecycle.park(runner, { kind: 'coordinator-seat-lost' })
        runner.leaseRenewal?.dispose()
        runner.leaseRenewal = null
        if (runner.leaseGuard) {
          await this.dependencies.leaseStore
            .release(runner.enrollment.workspaceKey, runner.leaseGuard.epoch)
            .catch(() => {})
          runner.leaseGuard = null
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
      this.dependencies.ledgerStore.appendTickTrace(runner.enrollment.watcherId, trace)
      if (releaseAtEnd) {
        const running = getInFlightAttempts(
          this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
        ).some((attempt) => attempt.state === 'running')
        if (!running && runner.leaseGuard) {
          runner.leaseRenewal?.dispose()
          runner.leaseRenewal = null
          await this.dependencies.leaseStore
            .release(runner.enrollment.workspaceKey, runner.leaseGuard.epoch)
            .catch(() => {})
          runner.leaseGuard = null
        }
      }
    }
  }

  private scheduleFromPacing(
    runner: WatcherRunner,
    snapshot: Snapshot<unknown>,
    ledger: WatcherLedger,
    trace: WatcherTickTrace
  ): void {
    const tier = runner.kind.pacing?.pace(snapshot, ledger) ?? 'idle'
    const pacing = derivePacing(tier, {
      consecutiveErrors: runner.consecutiveErrors,
      lastFullResyncAtMs: runner.lastFullResyncAtMs,
      evaluatedAtMs: this.now()
    })
    trace.pacing = pacing
    if (pacing.delayMs !== null) {
      this.schedule(runner, Math.min(pacing.delayMs, pacing.nextFullResyncInMs || pacing.delayMs))
    }
  }

  private append(runner: WatcherRunner, entry: LedgerEntry): void {
    this.dependencies.ledgerStore.append(runner.enrollment.watcherId, entry)
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
