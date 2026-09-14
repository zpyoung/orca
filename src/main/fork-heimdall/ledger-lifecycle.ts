import { randomUUID } from 'node:crypto'
import { deriveBudgetState } from '../../shared/fork-heimdall/budget'
import type {
  DispatchResult,
  DispatchWorkerInput,
  KernelAction
} from '../../shared/fork-heimdall/kind-contract'
import {
  getInFlightAttempts,
  getLatestAttemptForFingerprint,
  getUnresolvedAttempts
} from '../../shared/fork-heimdall/ledger-queries'
import type {
  AttemptEntry,
  LedgerEntry,
  WatcherLedger
} from '../../shared/fork-heimdall/ledger-types'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import type { HeimdallOrchestrationAdapter } from './orchestration/orchestration-adapter'
import { orchestrationRequestIdForAttemptFingerprint } from './orchestration/orchestration-adapter'

export type DispatchLifecycleInput = {
  enrollment: WatcherEnrollment
  action: KernelAction
  fingerprint: string
  spec: string
  agent?: string
  taskKey?: string
  dispatchKind?: 'planner' | 'child'
}

export type DispatchIntervalHandle = {
  watcherId: string
  intervalId: string
}

export type DispatchLifecycleLedgerStore = {
  read(watcherId: string): WatcherLedger
  append(watcherId: string, entry: LedgerEntry): void
}

export type DispatchLifecycleBudgetClock = {
  open(watcherId: string, cause: 'action-in-flight' | 'worker-dispatched'): DispatchIntervalHandle
  close(handle: DispatchIntervalHandle, reason: 'settled' | 'contact-lost' | 'shutdown'): void
  current?(watcherId: string): DispatchIntervalHandle | null
}

export class WatcherLedgerLifecycle {
  private readonly workerIntervals = new Map<string, DispatchIntervalHandle>()

  constructor(
    private readonly dependencies: {
      ledgerStore: DispatchLifecycleLedgerStore
      budgetClock: DispatchLifecycleBudgetClock
      adapter: Pick<HeimdallOrchestrationAdapter, 'dispatchWorker' | 'recoverDispatch'>
      now?: () => number
      createId?: () => string
    }
  ) {}

  async dispatch(input: DispatchLifecycleInput): Promise<DispatchResult> {
    const ledger = this.dependencies.ledgerStore.read(input.enrollment.watcherId)
    const budgetRefusal = this.preDispatchRefusal(input.enrollment, ledger)
    if (budgetRefusal) {
      return budgetRefusal
    }
    const previous = getLatestAttemptForFingerprint(ledger, input.fingerprint)
    if (previous) {
      const detail =
        previous.state !== 'settled'
          ? 'attempt-in-flight'
          : previous.effect === 'landed'
            ? 'attempt-completed'
            : previous.effect === 'indeterminate'
              ? 'unresolved-attempt'
              : 'retry-needs-new-evidence'
      return { status: 'refused', reason: 'capability-invalid', detail }
    }
    const attempt = this.attemptedEntry(input)
    this.dependencies.ledgerStore.append(input.enrollment.watcherId, attempt)
    return this.callAdapter(input, attempt)
  }

  /**
   * Decorates an action's existing write-ahead attempt with replay parameters before crossing the
   * orchestration database boundary. The appended transition is itself the crash recovery record.
   */
  async dispatchAttempt(
    attempt: AttemptEntry,
    input: DispatchLifecycleInput
  ): Promise<DispatchResult> {
    if (attempt.attemptId === '' || attempt.fingerprint !== input.fingerprint) {
      throw new Error('Dispatch attempt does not match the action fingerprint')
    }
    const ledger = this.dependencies.ledgerStore.read(input.enrollment.watcherId)
    const budget = deriveBudgetState(ledger, input.enrollment.budget)
    if (budget.exhausted) {
      return {
        status: 'refused',
        reason: 'capability-invalid',
        detail: `budget-${budget.exhausted.kind}`
      }
    }
    if (getUnresolvedAttempts(ledger).length > 0) {
      return {
        status: 'refused',
        reason: 'capability-invalid',
        detail: 'unresolved-attempt'
      }
    }
    const otherInFlight = getInFlightAttempts(ledger).some(
      (candidate) => candidate.attemptId !== attempt.attemptId
    )
    if (otherInFlight) {
      return { status: 'refused', reason: 'capability-invalid', detail: 'attempt-in-flight' }
    }
    const dispatchAttempt = this.withDispatchMetadata(attempt, input)
    this.dependencies.ledgerStore.append(input.enrollment.watcherId, dispatchAttempt)
    return this.callAdapter(input, dispatchAttempt)
  }
  /** Replays write-ahead dispatches and repairs older running rows that predate their turn. */
  async recover(enrollment: WatcherEnrollment): Promise<AttemptEntry[]> {
    let ledger = this.dependencies.ledgerStore.read(enrollment.watcherId)
    for (const attempt of getInFlightAttempts(ledger)) {
      if (attempt.state !== 'running' || !attempt.dispatchId) {
        continue
      }
      if (!this.hasTurn(ledger, attempt.attemptId, attempt.dispatchId)) {
        this.appendTurn(enrollment, attempt, attempt.dispatchId)
        ledger = this.dependencies.ledgerStore.read(enrollment.watcherId)
      }
    }
    const absent: AttemptEntry[] = []
    const pending = getInFlightAttempts(ledger).filter(
      (attempt) => attempt.state === 'attempted' && attempt.dispatch !== undefined
    )
    for (const attempt of pending) {
      const dispatch = attempt.dispatch
      if (!dispatch) {
        continue
      }
      const result = await this.dependencies.adapter.recoverDispatch({
        enrollment,
        attemptFingerprint: attempt.fingerprint,
        spec: dispatch.spec,
        ...(dispatch.agent ? { agent: dispatch.agent } : {}),
        ...(dispatch.taskKey ? { taskKey: dispatch.taskKey } : {})
      })
      if (result.status === 'absent') {
        absent.push(attempt)
      } else {
        this.recordDispatchResult(enrollment, attempt, result)
      }
    }
    return absent
  }

  observeWorkerLive(watcherId: string, dispatchId: string): void {
    const ledger = this.dependencies.ledgerStore.read(watcherId)
    const attempt = getInFlightAttempts(ledger).find(
      (candidate) => candidate.state === 'running' && candidate.dispatchId === dispatchId
    )
    if (!attempt || this.workerIntervals.has(attempt.attemptId)) {
      return
    }
    const current = this.dependencies.budgetClock.current?.(watcherId) ?? null
    this.workerIntervals.set(
      attempt.attemptId,
      current ?? this.dependencies.budgetClock.open(watcherId, 'worker-dispatched')
    )
  }
  pauseWorker(watcherId: string, dispatchId: string): void {
    const ledger = this.dependencies.ledgerStore.read(watcherId)
    const attempt = getInFlightAttempts(ledger).find(
      (candidate) => candidate.state === 'running' && candidate.dispatchId === dispatchId
    )
    if (!attempt) {
      return
    }
    const interval =
      this.workerIntervals.get(attempt.attemptId) ??
      this.dependencies.budgetClock.current?.(watcherId) ??
      null
    if (!interval) {
      return
    }
    this.dependencies.budgetClock.close(interval, 'settled')
    this.workerIntervals.delete(attempt.attemptId)
  }

  /** Settles a dispatched worker only from authoritative mailbox evidence. */
  settleWorker(input: {
    watcherId: string
    dispatchId: string
    effect: 'landed' | 'not-landed' | 'indeterminate'
    result?: unknown
    reason?: string
  }): void {
    const ledger = this.dependencies.ledgerStore.read(input.watcherId)
    const attempt = getInFlightAttempts(ledger).find(
      (candidate) => candidate.state === 'running' && candidate.dispatchId === input.dispatchId
    )
    if (!attempt) {
      return
    }
    this.dependencies.ledgerStore.append(input.watcherId, {
      ...attempt,
      eventId: this.createId(),
      atMs: this.now(),
      state: 'settled',
      effect: input.effect,
      ...(input.result === undefined ? {} : { result: input.result }),
      ...(input.reason === undefined ? {} : { reason: input.reason })
    })
    const interval =
      this.workerIntervals.get(attempt.attemptId) ??
      this.dependencies.budgetClock.current?.(input.watcherId) ??
      null
    if (interval) {
      this.dependencies.budgetClock.close(interval, 'settled')
      this.workerIntervals.delete(attempt.attemptId)
    }
  }

  closeForContactLoss(watcherId: string): void {
    for (const [attemptId, interval] of this.workerIntervals) {
      if (interval.watcherId !== watcherId) {
        continue
      }
      this.dependencies.budgetClock.close(interval, 'contact-lost')
      this.workerIntervals.delete(attemptId)
    }
  }

  closeForShutdown(): void {
    for (const [attemptId, interval] of this.workerIntervals) {
      this.dependencies.budgetClock.close(interval, 'shutdown')
      this.workerIntervals.delete(attemptId)
    }
  }

  private attemptedEntry(input: DispatchLifecycleInput): AttemptEntry {
    const attemptId = this.createId()
    return {
      eventId: this.createId(),
      watcherId: input.enrollment.watcherId,
      atMs: this.now(),
      origin: 'owner',
      class: 'fact',
      kind: 'attempt',
      attemptId,
      fingerprint: input.fingerprint,
      action: input.action,
      state: 'attempted',
      orchestrationRequestId: orchestrationRequestIdForAttemptFingerprint(input.fingerprint),
      dispatch: {
        spec: input.spec,
        dispatchKind: input.dispatchKind ?? 'child',
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.taskKey ? { taskKey: input.taskKey } : {})
      }
    }
  }

  private withDispatchMetadata(attempt: AttemptEntry, input: DispatchLifecycleInput): AttemptEntry {
    return {
      ...attempt,
      eventId: this.createId(),
      atMs: this.now(),
      orchestrationRequestId: orchestrationRequestIdForAttemptFingerprint(input.fingerprint),
      dispatch: {
        spec: input.spec,
        dispatchKind: input.dispatchKind ?? 'child',
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.taskKey ? { taskKey: input.taskKey } : {})
      }
    }
  }

  private preDispatchRefusal(
    enrollment: WatcherEnrollment,
    ledger: WatcherLedger
  ): Extract<DispatchResult, { status: 'refused' }> | null {
    const budget = deriveBudgetState(ledger, enrollment.budget)
    if (budget.exhausted) {
      return {
        status: 'refused',
        reason: 'capability-invalid',
        detail: `budget-${budget.exhausted.kind}`
      }
    }
    if (getUnresolvedAttempts(ledger).length > 0) {
      return {
        status: 'refused',
        reason: 'capability-invalid',
        detail: 'unresolved-attempt'
      }
    }
    if (getInFlightAttempts(ledger).length > 0) {
      return { status: 'refused', reason: 'capability-invalid', detail: 'attempt-in-flight' }
    }
    return null
  }

  private async callAdapter(
    input: DispatchLifecycleInput,
    attempt: AttemptEntry
  ): Promise<DispatchResult> {
    const result = await this.dependencies.adapter.dispatchWorker(this.adapterInput(input))
    this.recordDispatchResult(input.enrollment, attempt, result)
    return result
  }

  private adapterInput(input: DispatchLifecycleInput): DispatchWorkerInput {
    return {
      enrollment: input.enrollment,
      attemptFingerprint: input.fingerprint,
      spec: input.spec,
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.taskKey ? { taskKey: input.taskKey } : {})
    }
  }

  private recordDispatchResult(
    enrollment: WatcherEnrollment,
    attempt: AttemptEntry,
    result: DispatchResult
  ): void {
    if (result.status === 'dispatched') {
      const ledger = this.dependencies.ledgerStore.read(enrollment.watcherId)
      if (!this.hasTurn(ledger, attempt.attemptId, result.dispatchId)) {
        this.appendTurn(enrollment, attempt, result.dispatchId)
      }
      const latest = getInFlightAttempts(
        this.dependencies.ledgerStore.read(enrollment.watcherId)
      ).find((candidate) => candidate.attemptId === attempt.attemptId)
      if (latest?.state !== 'running') {
        this.dependencies.ledgerStore.append(enrollment.watcherId, {
          ...attempt,
          eventId: this.createId(),
          atMs: this.now(),
          state: 'running',
          dispatchId: result.dispatchId
        })
      }
      if (!this.workerIntervals.has(attempt.attemptId)) {
        const current = this.dependencies.budgetClock.current?.(enrollment.watcherId) ?? null
        this.workerIntervals.set(
          attempt.attemptId,
          current ?? this.dependencies.budgetClock.open(enrollment.watcherId, 'worker-dispatched')
        )
      }
      return
    }

    this.dependencies.ledgerStore.append(enrollment.watcherId, {
      ...attempt,
      eventId: this.createId(),
      atMs: this.now(),
      state: 'settled',
      effect: result.status === 'indeterminate' ? 'indeterminate' : 'not-landed',
      reason: result.status === 'indeterminate' ? 'operation-unknown' : result.reason,
      result
    })
  }
  private hasTurn(ledger: WatcherLedger, attemptId: string, dispatchId: string): boolean {
    return ledger.entries.some(
      (entry) =>
        entry.kind === 'turn' && (entry.attemptId === attemptId || entry.dispatchId === dispatchId)
    )
  }

  private appendTurn(
    enrollment: WatcherEnrollment,
    attempt: AttemptEntry,
    dispatchId: string
  ): void {
    this.dependencies.ledgerStore.append(enrollment.watcherId, {
      eventId: this.createId(),
      watcherId: enrollment.watcherId,
      atMs: this.now(),
      origin: 'owner',
      class: 'fact',
      kind: 'turn',
      dispatchKind: attempt.dispatch?.dispatchKind ?? 'child',
      attemptId: attempt.attemptId,
      dispatchId
    })
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now()
  }

  private createId(): string {
    return this.dependencies.createId?.() ?? randomUUID()
  }
}
