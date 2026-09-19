import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import { WORKER_EXITED_WITHOUT_COMPLETION } from '../../shared/fork-heimdall/effect-certainty'
import type { GateVerdict } from '../../shared/fork-heimdall/gate'
import type { KernelAction, LeaseGuard } from '../../shared/fork-heimdall/kind-contract'
import {
  getInFlightAttempts,
  getLatestAttempts,
  getLatestEscalations,
  getUnresolvedAttempts
} from '../../shared/fork-heimdall/ledger-queries'
import type {
  AttemptEntry,
  LedgerEntry,
  WatcherLedger
} from '../../shared/fork-heimdall/ledger-types'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import type { HeimdallOrchestrationAdapter } from './orchestration/orchestration-adapter'
import type { WatcherLedgerLifecycle } from './ledger-lifecycle'
import { WatcherAttemptRecovery } from './runner-attempt-recovery'
import { releaseSettledWorker } from './runner-worker-release'
import type { RunnerBudgetClock, RunnerLedgerStore, WatcherRunner } from './runner-state'

export type WatcherRunnerActionDependencies = {
  ledgerStore: RunnerLedgerStore
  budgetClock: RunnerBudgetClock
  orchestration: HeimdallOrchestrationAdapter
  dispatchLifecycle: WatcherLedgerLifecycle
  notifyApproval?(enrollment: WatcherEnrollment, action: KernelAction): void
  now(): number
  createId(): string
}
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function confirmedNotLanded(
  error: unknown
): { effect: 'not-landed'; reason: string; result?: unknown } | null {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('effect' in error) ||
    error.effect !== 'not-landed' ||
    !('reason' in error) ||
    typeof error.reason !== 'string' ||
    !error.reason.trim()
  ) {
    return null
  }
  return {
    effect: 'not-landed',
    reason: error.reason,
    ...('result' in error ? { result: error.result } : {})
  }
}

export class WatcherRunnerActions {
  private readonly attemptRecovery: WatcherAttemptRecovery

  constructor(private readonly dependencies: WatcherRunnerActionDependencies) {
    this.attemptRecovery = new WatcherAttemptRecovery({
      ledgerStore: dependencies.ledgerStore,
      now: dependencies.now,
      createId: dependencies.createId,
      replay: async (runner, snapshot, attempt) =>
        await this.execute(runner, snapshot, attempt.action, attempt)
    })
  }

  async execute(
    runner: WatcherRunner,
    snapshot: Snapshot<unknown>,
    action: KernelAction,
    recoveredAttempt?: AttemptEntry
  ): Promise<boolean> {
    if (!this.executionAllowed(runner)) {
      if (recoveredAttempt) {
        this.attemptRecovery.settleRecoveredNotRun(runner, recoveredAttempt)
      }
      return false
    }
    const rawLease = runner.leaseGuard
    if (!rawLease) {
      throw new Error('Watcher action reached execution without a lease')
    }
    const executionLease = this.executionLease(runner, rawLease)
    try {
      await executionLease.assertHeld()
    } catch (error) {
      if (!this.executionAllowed(runner)) {
        if (recoveredAttempt) {
          this.attemptRecovery.settleRecoveredNotRun(runner, recoveredAttempt)
        }
        return false
      }
      throw error
    }
    const fingerprint = makeAttemptFingerprint(
      action.contentIdentity,
      action.kind,
      action.evidenceKey
    )
    const expectation = recoveredAttempt
      ? undefined
      : runner.kind.attemptExpectation?.(action, snapshot)
    const attempt: AttemptEntry = recoveredAttempt ?? {
      eventId: this.dependencies.createId(),
      watcherId: runner.enrollment.watcherId,
      atMs: this.dependencies.now(),
      origin: 'owner',
      class: 'fact',
      kind: 'attempt',
      attemptId: this.dependencies.createId(),
      fingerprint,
      action,
      state: 'attempted',
      ...expectation
    }
    if (attempt.fingerprint !== fingerprint || attempt.state !== 'attempted') {
      throw new Error('Recovered attempt does not match the current action')
    }
    if (!recoveredAttempt) {
      this.append(runner, attempt)
    }
    const interval = this.dependencies.budgetClock.open(
      runner.enrollment.watcherId,
      'action-in-flight'
    )
    let dispatched = false
    try {
      const outcome = await runner.kind.execute(action, {
        snapshot,
        lease: executionLease,
        ledger: this.dependencies.ledgerStore.read(runner.enrollment.watcherId),
        dispatchWorker: async (request) => {
          await executionLease.assertHeld()
          const result = await this.dependencies.dispatchLifecycle.dispatchAttempt(attempt, {
            lease: executionLease,
            enrollment: runner.enrollment,
            action,
            fingerprint,
            dispatchKind: 'child',
            ...request
          })
          dispatched = result.status === 'dispatched'
          return result
        }
      })
      await rawLease.assertHeld()
      const latest = getLatestAttempts(
        this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
      ).find((entry) => entry.attemptId === attempt.attemptId)
      if (latest?.state === 'settled') {
        return true
      }
      if (latest?.state === 'running' || dispatched) {
        return true
      }
      this.append(runner, {
        ...(latest ?? attempt),
        eventId: this.dependencies.createId(),
        atMs: this.dependencies.now(),
        state: 'settled',
        ...outcome
      })
      return true
    } catch (error) {
      const latest = getLatestAttempts(
        this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
      ).find((entry) => entry.attemptId === attempt.attemptId)
      if (latest?.state === 'settled') {
        return true
      }
      const leaseLost = error instanceof Error && error.name === 'LeaseLostError'
      const knownNotLanded = leaseLost ? null : confirmedNotLanded(error)
      if (latest?.state === 'attempted' && latest.dispatch) {
        throw error
      }
      if (latest?.state !== 'running') {
        this.append(runner, {
          ...(latest ?? attempt),
          eventId: this.dependencies.createId(),
          atMs: this.dependencies.now(),
          state: 'settled',
          ...(knownNotLanded ?? {
            effect: 'indeterminate' as const,
            reason: leaseLost ? 'lease-lost' : errorText(error)
          })
        })
      }
      if (knownNotLanded) {
        return this.executionAllowed(runner)
      }
      throw error
    } finally {
      const running = getInFlightAttempts(
        this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
      ).some((entry) => entry.attemptId === attempt.attemptId && entry.state === 'running')
      const currentInterval = this.dependencies.budgetClock.current?.(runner.enrollment.watcherId)
      if (!running && currentInterval?.intervalId === interval.intervalId) {
        this.dependencies.budgetClock.close(interval, 'settled')
      }
    }
  }

  async recoverBeforeStop(
    runner: WatcherRunner,
    snapshot: Snapshot<unknown>,
    absentDispatches: readonly AttemptEntry[]
  ): Promise<WatcherLedger> {
    this.settleAbsentDispatches(runner, absentDispatches)
    await this.recoverAttempts(
      runner,
      snapshot,
      this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
    )
    return this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
  }

  async recoverAttempts(
    runner: WatcherRunner,
    snapshot: Snapshot<unknown>,
    ledger: WatcherLedger
  ): Promise<void> {
    for (const attempt of getUnresolvedAttempts(ledger)) {
      if (attempt.reason === WORKER_EXITED_WITHOUT_COMPLETION && attempt.dispatchId !== undefined) {
        await releaseSettledWorker(runner, attempt.dispatchId, this.dependencies)
      }
    }
    await this.attemptRecovery.recover(runner, snapshot, ledger)
  }

  acknowledgePark(watcherId: string): void {
    const open = getLatestEscalations(this.dependencies.ledgerStore.read(watcherId))
      .toReversed()
      .find((entry) => entry.status === 'open' && entry.escalationKind.startsWith('park-'))
    if (!open) {
      return
    }
    this.dependencies.ledgerStore.append(watcherId, {
      ...open,
      eventId: this.dependencies.createId(),
      atMs: this.dependencies.now(),
      status: 'acknowledged',
      foldCount: open.foldCount + 1
    })
  }

  settleAbsentDispatches(runner: WatcherRunner, attempts: readonly AttemptEntry[]): void {
    this.attemptRecovery.settleAbsentDispatches(runner, attempts)
  }

  abandonPendingAttempts(runner: WatcherRunner, ledger: WatcherLedger): void {
    this.attemptRecovery.abandonPendingAttempts(runner, ledger)
  }

  abandonFingerprint(
    runner: WatcherRunner,
    fingerprint: string,
    reason: 'workspace-moved' | 'lease-refused' | 'gate-hold'
  ): void {
    this.append(runner, {
      eventId: this.dependencies.createId(),
      watcherId: runner.enrollment.watcherId,
      atMs: this.dependencies.now(),
      origin: 'owner',
      class: 'observation',
      kind: 'attempt-abandoned',
      fingerprint,
      reason
    })
  }

  recordGateRejection(
    runner: WatcherRunner,
    action: KernelAction,
    verdict: Exclude<GateVerdict, { verdict: 'allow' }>,
    advisory?: string
  ): void {
    const fingerprint = makeAttemptFingerprint(
      action.contentIdentity,
      action.kind,
      action.evidenceKey
    )
    // the gate re-evaluates the same held action every tick; only the first hold is a new observation
    if (this.latestAbandonReason(runner, fingerprint) !== 'gate-hold') {
      this.abandonFingerprint(runner, fingerprint, 'gate-hold')
    }
    if (verdict.verdict === 'hold' && verdict.escalation) {
      this.append(runner, {
        eventId: this.dependencies.createId(),
        watcherId: runner.enrollment.watcherId,
        atMs: this.dependencies.now(),
        origin: 'owner',
        class: 'fact',
        kind: 'escalation',
        escalationId: verdict.escalation.escalationId,
        escalationKind: verdict.escalation.escalationKind,
        status: 'open',
        foldCount: verdict.escalation.foldCount,
        approvalScope: verdict.escalation.approvalScope,
        reason: advisory ? `${verdict.reason}\n${advisory}` : verdict.reason
      })
      if (verdict.escalation.foldCount === 1) {
        this.dependencies.notifyApproval?.(runner.enrollment, action)
      }
    }
  }

  private latestAbandonReason(runner: WatcherRunner, fingerprint: string): string | null {
    const ledger = this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
    let latest: string | null = null
    for (const entry of ledger.entries) {
      if (entry.kind === 'attempt-abandoned' && entry.fingerprint === fingerprint) {
        latest = entry.reason
      }
    }
    return latest
  }

  private executionAllowed(runner: WatcherRunner): boolean {
    return (
      !runner.stopped &&
      !runner.suspended &&
      runner.controlPending === null &&
      runner.enrollment.enabled &&
      !runner.enrollment.paused
    )
  }

  private executionLease(runner: WatcherRunner, rawLease: LeaseGuard): LeaseGuard {
    return {
      epoch: rawLease.epoch,
      holder: rawLease.holder,
      renewLoop: () => rawLease.renewLoop(),
      assertHeld: async () => {
        this.assertExecutionAllowed(runner)
        await rawLease.assertHeld()
        this.assertExecutionAllowed(runner)
      }
    }
  }

  private assertExecutionAllowed(runner: WatcherRunner): void {
    if (this.executionAllowed(runner)) {
      return
    }
    const reason = runner.controlPending
      ? `${runner.controlPending}-requested`
      : runner.enrollment.paused
        ? 'paused'
        : 'disabled'
    throw Object.assign(new Error(`Watcher execution is fenced: ${reason}`), {
      effect: 'not-landed' as const,
      reason
    })
  }

  private append(runner: WatcherRunner, entry: LedgerEntry): void {
    this.dependencies.ledgerStore.append(runner.enrollment.watcherId, entry)
  }
}
