import { randomUUID } from 'node:crypto'
import {
  attemptPredatesCurrentBudgetGeneration,
  deriveBudgetState
} from '../../shared/fork-heimdall/budget'
import type {
  DispatchResult,
  DispatchWorkerInput,
  KernelAction,
  LeaseGuard
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
  model?: string
  effort?: string
  taskKey?: string
  deps?: readonly string[]
  workspaceId?: string
  reuseTerminal?: string
  allowConcurrent?: boolean
  allowBudgetExhausted?: boolean
  lease?: LeaseGuard
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
    const budgetRefusal = this.preDispatchRefusal(input, ledger)
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
    if (budget.exhausted && !input.allowBudgetExhausted) {
      return {
        status: 'refused',
        reason: 'capability-invalid',
        detail: `budget-${budget.exhausted.kind}`
      }
    }
    if (!input.allowConcurrent && getUnresolvedAttempts(ledger).length > 0) {
      return {
        status: 'refused',
        reason: 'capability-invalid',
        detail: 'unresolved-attempt'
      }
    }
    const otherInFlight = getInFlightAttempts(ledger).some(
      (candidate) => candidate.attemptId !== attempt.attemptId
    )
    if (!input.allowConcurrent && otherInFlight) {
      return { status: 'refused', reason: 'capability-invalid', detail: 'attempt-in-flight' }
    }
    const dispatchAttempt = this.withDispatchMetadata(attempt, input)
    this.dependencies.ledgerStore.append(input.enrollment.watcherId, dispatchAttempt)
    return this.callAdapter(input, dispatchAttempt)
  }
  /** Recovers write-ahead and unresolved dispatch receipts, and repairs missing turn facts. */
  async recover(enrollment: WatcherEnrollment, lease?: LeaseGuard): Promise<AttemptEntry[]> {
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
    const attempted = getInFlightAttempts(ledger).filter(
      (attempt) => attempt.state === 'attempted' && attempt.dispatch !== undefined
    )
    const unresolved = getUnresolvedAttempts(ledger).filter(
      (attempt) => attempt.dispatch !== undefined && attempt.dispatchId === undefined
    )
    const pending = [...attempted, ...unresolved]
    const absent: AttemptEntry[] = []
    for (const attempt of pending) {
      const dispatch = attempt.dispatch
      // pending only ever holds attempted or settled-indeterminate revisions, and both still carry spec
      if (!dispatch?.spec) {
        continue
      }
      const result = await this.dependencies.adapter.recoverDispatch({
        enrollment,
        attemptFingerprint: attempt.fingerprint,
        spec: dispatch.spec,
        ...(dispatch.agent ? { agent: dispatch.agent } : {}),
        ...(dispatch.taskKey ? { taskKey: dispatch.taskKey } : {}),
        ...(dispatch.deps ? { deps: dispatch.deps } : {}),
        ...(dispatch.workspaceId ? { workspaceId: dispatch.workspaceId } : {}),
        ...(dispatch.reuseTerminal ? { reuseTerminal: dispatch.reuseTerminal } : {})
      })
      await lease?.assertHeld()
      if (attempt.state === 'settled') {
        this.recordRecoveredUncertainDispatch(enrollment, attempt, result)
      } else if (result.status === 'absent') {
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
    if (
      !attempt ||
      this.workerIntervals.has(attempt.attemptId) ||
      attemptPredatesCurrentBudgetGeneration(ledger, attempt.attemptId)
    ) {
      return
    }
    this.workerIntervals.set(
      attempt.attemptId,
      this.dependencies.budgetClock.open(watcherId, 'worker-dispatched')
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
    const interval = this.workerIntervals.get(attempt.attemptId)
    if (!interval) {
      return
    }
    this.dependencies.budgetClock.close(interval, 'settled')
    this.workerIntervals.delete(attempt.attemptId)
  }

  /**
   * Settles a dispatched worker only from authoritative mailbox evidence. A failed outcome settles
   * `indeterminate` rather than `not-landed`: the mailbox is authoritative that it didn't land, but
   * not yet why, and resolveOutcome needs that gap open to classify it on the next reconciliation.
   */
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
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.effect === 'indeterminate' || !attempt.dispatch
        ? {}
        : { dispatch: this.withoutDispatchSpec(attempt.dispatch) })
    })
    const interval = this.workerIntervals.get(attempt.attemptId)
    if (interval) {
      this.dependencies.budgetClock.close(interval, 'settled')
      this.workerIntervals.delete(attempt.attemptId)
    }
  }

  closeWorkerForContactLoss(watcherId: string, dispatchId: string): void {
    const attempt = getInFlightAttempts(this.dependencies.ledgerStore.read(watcherId)).find(
      (candidate) => candidate.state === 'running' && candidate.dispatchId === dispatchId
    )
    if (!attempt) {
      return
    }
    const interval = this.workerIntervals.get(attempt.attemptId)
    if (!interval) {
      return
    }
    this.dependencies.budgetClock.close(interval, 'contact-lost')
    this.workerIntervals.delete(attempt.attemptId)
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
        ...(input.deps ? { deps: [...input.deps] } : {}),
        ...(input.taskKey ? { taskKey: input.taskKey } : {}),
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        ...(input.reuseTerminal ? { reuseTerminal: input.reuseTerminal } : {})
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
        ...(input.deps ? { deps: [...input.deps] } : {}),
        ...(input.taskKey ? { taskKey: input.taskKey } : {}),
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        ...(input.reuseTerminal ? { reuseTerminal: input.reuseTerminal } : {})
      }
    }
  }

  // a determinate settlement no longer needs the prompt recover() would have replayed against it
  private withoutDispatchSpec(
    dispatch: NonNullable<AttemptEntry['dispatch']>
  ): AttemptEntry['dispatch'] {
    const { spec: _spec, ...rest } = dispatch
    return rest
  }

  private preDispatchRefusal(
    input: DispatchLifecycleInput,
    ledger: WatcherLedger
  ): Extract<DispatchResult, { status: 'refused' }> | null {
    const budget = deriveBudgetState(ledger, input.enrollment.budget)
    if (budget.exhausted && !input.allowBudgetExhausted) {
      return {
        status: 'refused',
        reason: 'capability-invalid',
        detail: `budget-${budget.exhausted.kind}`
      }
    }
    if (!input.allowConcurrent && getUnresolvedAttempts(ledger).length > 0) {
      return {
        status: 'refused',
        reason: 'capability-invalid',
        detail: 'unresolved-attempt'
      }
    }
    if (!input.allowConcurrent && getInFlightAttempts(ledger).length > 0) {
      return { status: 'refused', reason: 'capability-invalid', detail: 'attempt-in-flight' }
    }
    return null
  }

  private async callAdapter(
    input: DispatchLifecycleInput,
    attempt: AttemptEntry
  ): Promise<DispatchResult> {
    await input.lease?.assertHeld()
    const result = await this.dependencies.adapter.dispatchWorker(this.adapterInput(input))
    await input.lease?.assertHeld()
    this.recordDispatchResult(input.enrollment, attempt, result)
    return result
  }

  private adapterInput(input: DispatchLifecycleInput): DispatchWorkerInput {
    return {
      enrollment: input.enrollment,
      attemptFingerprint: input.fingerprint,
      spec: input.spec,
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.deps ? { deps: input.deps } : {}),
      ...(input.taskKey ? { taskKey: input.taskKey } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.reuseTerminal ? { reuseTerminal: input.reuseTerminal } : {})
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
        const runningAttempt: AttemptEntry = {
          ...attempt,
          eventId: this.createId(),
          atMs: this.now(),
          state: 'running',
          dispatchId: result.dispatchId
        }
        delete runningAttempt.effect
        delete runningAttempt.reason
        delete runningAttempt.result
        this.dependencies.ledgerStore.append(enrollment.watcherId, runningAttempt)
      }
      if (
        !this.workerIntervals.has(attempt.attemptId) &&
        !attemptPredatesCurrentBudgetGeneration(ledger, attempt.attemptId)
      ) {
        this.workerIntervals.set(
          attempt.attemptId,
          this.dependencies.budgetClock.open(enrollment.watcherId, 'worker-dispatched')
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
      result,
      ...(result.status === 'indeterminate' || !attempt.dispatch
        ? {}
        : { dispatch: this.withoutDispatchSpec(attempt.dispatch) })
    })
  }
  private recordRecoveredUncertainDispatch(
    enrollment: WatcherEnrollment,
    attempt: AttemptEntry,
    result: DispatchResult | { status: 'absent' }
  ): void {
    if (result.status === 'dispatched') {
      this.recordDispatchResult(enrollment, attempt, result)
    } else if (result.status === 'refused' || result.status === 'absent') {
      this.dependencies.ledgerStore.append(enrollment.watcherId, {
        eventId: this.createId(),
        watcherId: enrollment.watcherId,
        atMs: this.now(),
        origin: 'owner',
        class: 'fact',
        kind: 'attempt-resolved',
        attemptId: attempt.attemptId,
        effect: 'not-landed',
        evidence: result
      })
    }
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
