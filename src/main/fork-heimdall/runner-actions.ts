import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import type { GateVerdict } from '../../shared/fork-heimdall/gate'
import type { KernelAction } from '../../shared/fork-heimdall/kind-contract'
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
import { requireLiveSnapshot, type Snapshot } from '../../shared/fork-heimdall/snapshot'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import type {
  HeimdallOrchestrationAdapter,
  MailboxCursor
} from './orchestration/orchestration-adapter'
import type { WatcherLedgerLifecycle } from './ledger-lifecycle'
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
export type WorkerReconciliation =
  | { status: 'clear' }
  | { status: 'question'; messageId: string }
  | { status: 'exited' }
  | { status: 'unverifiable'; reason: string }

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
function mailboxBody(entry: Extract<LedgerEntry, { kind: 'evidence' }>): {
  type: string
  messageId?: string
  dispatchId?: string
  outcome?: string
  result?: unknown
  body?: string
} | null {
  if (
    entry.evidenceKind !== 'orchestration-mailbox' ||
    typeof entry.payload !== 'object' ||
    entry.payload === null
  ) {
    return null
  }
  const envelope = entry.payload as Record<string, unknown>
  const type = typeof envelope.type === 'string' ? envelope.type : ''
  let payload: Record<string, unknown> = {}
  if (typeof envelope.payload === 'string') {
    try {
      const parsed: unknown = JSON.parse(envelope.payload)
      if (typeof parsed === 'object' && parsed !== null) {
        payload = parsed as Record<string, unknown>
      }
    } catch {
      payload = {}
    }
  } else if (typeof envelope.payload === 'object' && envelope.payload !== null) {
    payload = envelope.payload as Record<string, unknown>
  }
  return {
    type,
    ...(entry.source?.kind === 'orchestration' ? { messageId: entry.source.messageId } : {}),
    ...(typeof payload.dispatchId === 'string' ? { dispatchId: payload.dispatchId } : {}),
    ...(typeof payload.outcome === 'string' ? { outcome: payload.outcome } : {}),
    ...(payload.result === undefined ? {} : { result: payload.result }),
    ...(typeof envelope.body === 'string' ? { body: envelope.body } : {})
  }
}

/** The run boundary makes a replacement run's sequence namespace start fresh without deleting history. */
function mailboxCursor(ledger: WatcherLedger): MailboxCursor {
  let cursor: MailboxCursor = { previousDeliveryId: null, lastSequence: -1 }
  for (const entry of ledger.entries) {
    if (entry.kind !== 'evidence') {
      continue
    }
    if (entry.evidenceKind === 'orchestration-run-boundary') {
      cursor = { previousDeliveryId: null, lastSequence: -1 }
    } else if (entry.source?.kind === 'orchestration') {
      cursor = {
        previousDeliveryId: entry.source.deliveryId ?? cursor.previousDeliveryId,
        lastSequence: Math.max(cursor.lastSequence, entry.source.sequence)
      }
    }
  }
  return cursor
}

function hasSequenceSinceRunBoundary(ledger: WatcherLedger, sequence: number): boolean {
  let found = false
  for (const entry of ledger.entries) {
    if (entry.kind !== 'evidence') {
      continue
    }
    if (entry.evidenceKind === 'orchestration-run-boundary') {
      found = false
    } else if (entry.source?.kind === 'orchestration' && entry.source.sequence === sequence) {
      found = true
    }
  }
  return found
}

export class WatcherRunnerActions {
  constructor(private readonly dependencies: WatcherRunnerActionDependencies) {}

  async execute(
    runner: WatcherRunner,
    snapshot: Snapshot<unknown>,
    action: KernelAction,
    recoveredAttempt?: AttemptEntry
  ): Promise<void> {
    const fingerprint = makeAttemptFingerprint(
      action.contentIdentity,
      action.kind,
      action.evidenceKey
    )
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
      state: 'attempted'
    }
    if (attempt.fingerprint !== fingerprint || attempt.state !== 'attempted') {
      throw new Error('Recovered dispatch attempt does not match the current action')
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
        lease: runner.leaseGuard!,
        ledger: this.dependencies.ledgerStore.read(runner.enrollment.watcherId),
        dispatchWorker: async (request) => {
          const result = await this.dependencies.dispatchLifecycle.dispatchAttempt(attempt, {
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
      await runner.leaseGuard!.assertHeld()
      const latest = getLatestAttempts(
        this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
      ).find((entry) => entry.attemptId === attempt.attemptId)
      if (latest?.state === 'settled') {
        return
      }
      if (latest?.state === 'running' || dispatched) {
        return
      }
      this.append(runner, {
        ...(latest ?? attempt),
        eventId: this.dependencies.createId(),
        atMs: this.dependencies.now(),
        state: 'settled',
        ...outcome
      })
    } catch (error) {
      const latest = getLatestAttempts(
        this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
      ).find((entry) => entry.attemptId === attempt.attemptId)
      if (latest?.state === 'settled') {
        return
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
        return
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

  async reconcileWorkers(runner: WatcherRunner): Promise<WorkerReconciliation> {
    const ledger = this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
    const entries = await this.dependencies.orchestration.drainMailbox({
      enrollment: runner.enrollment,
      cursor: mailboxCursor(ledger)
    })
    let question: { messageId: string; dispatchId?: string; reason: string } | null = null
    for (const entry of entries) {
      if (
        entry.kind === 'evidence' &&
        entry.source &&
        hasSequenceSinceRunBoundary(ledger, entry.source.sequence)
      ) {
        continue
      }
      this.append(runner, entry)
      if (entry.kind !== 'evidence') {
        continue
      }
      const body = mailboxBody(entry)
      if (!body) {
        continue
      }
      if (body.type === 'question' && body.messageId) {
        question = {
          messageId: body.messageId,
          ...(body.dispatchId ? { dispatchId: body.dispatchId } : {}),
          reason: body.body ?? 'Worker requested input'
        }
        if (body.dispatchId) {
          this.dependencies.dispatchLifecycle.pauseWorker(
            runner.enrollment.watcherId,
            body.dispatchId
          )
        }
        this.append(runner, {
          eventId: this.dependencies.createId(),
          watcherId: runner.enrollment.watcherId,
          atMs: this.dependencies.now(),
          origin: 'owner',
          class: 'fact',
          kind: 'escalation',
          escalationId: `worker-question:${body.dispatchId ?? 'unknown'}:${body.messageId}`,
          escalationKind: 'worker-question',
          status: 'open',
          foldCount: 1,
          reason: `${body.messageId}: ${question.reason}`
        })
        continue
      }
      if (!body.dispatchId) {
        continue
      }
      if (body.type === 'heartbeat' || body.type === 'status') {
        this.dependencies.dispatchLifecycle.observeWorkerLive(
          runner.enrollment.watcherId,
          body.dispatchId
        )
      } else if (body.type === 'worker_done') {
        this.dependencies.dispatchLifecycle.settleWorker({
          watcherId: runner.enrollment.watcherId,
          dispatchId: body.dispatchId,
          effect:
            body.outcome === 'succeeded'
              ? 'landed'
              : body.outcome === 'failed'
                ? 'not-landed'
                : 'indeterminate',
          result: body.result ?? body.body,
          reason: body.outcome
        })
      }
    }

    const currentLedger = this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
    const pendingQuestion = question ?? this.pendingWorkerQuestion(currentLedger)
    if (pendingQuestion) {
      return { status: 'question', messageId: pendingQuestion.messageId }
    }

    let exited = false
    for (const attempt of getInFlightAttempts(currentLedger)) {
      if (attempt.state !== 'running' || !attempt.dispatchId) {
        continue
      }
      const observation = await this.dependencies.orchestration.readDispatch(
        runner.enrollment,
        attempt.dispatchId
      )
      if (observation.status === 'live') {
        this.dependencies.dispatchLifecycle.observeWorkerLive(
          runner.enrollment.watcherId,
          attempt.dispatchId
        )
      } else if (observation.status === 'exited') {
        this.dependencies.dispatchLifecycle.settleWorker({
          watcherId: runner.enrollment.watcherId,
          dispatchId: attempt.dispatchId,
          effect: 'indeterminate',
          reason: 'worker-exited-without-completion'
        })
        exited = true
      } else {
        this.dependencies.dispatchLifecycle.closeForContactLoss(runner.enrollment.watcherId)
        return {
          status: 'unverifiable',
          reason: observation.reason ?? 'Worker liveness could not be verified'
        }
      }
    }
    return exited ? { status: 'exited' } : { status: 'clear' }
  }
  private pendingWorkerQuestion(ledger: WatcherLedger): { messageId: string } | null {
    const escalation = getLatestEscalations(ledger)
      .toReversed()
      .find(
        (entry) =>
          entry.escalationKind === 'worker-question' &&
          entry.status === 'open' &&
          entry.escalationId.startsWith('worker-question:')
      )
    if (!escalation) {
      return null
    }
    const messageId = escalation.escalationId.split(':').at(-1)
    return messageId ? { messageId } : null
  }

  resolveUncertainAttempts(
    runner: WatcherRunner,
    snapshot: Snapshot<unknown>,
    ledger: WatcherLedger
  ): void {
    const live = requireLiveSnapshot(snapshot)
    for (const attempt of getUnresolvedAttempts(ledger)) {
      const effect = runner.kind.resolveOutcome(attempt, live)
      if (effect === 'indeterminate') {
        continue
      }
      this.append(runner, {
        eventId: this.dependencies.createId(),
        watcherId: runner.enrollment.watcherId,
        atMs: this.dependencies.now(),
        origin: 'owner',
        class: 'fact',
        kind: 'attempt-resolved',
        attemptId: attempt.attemptId,
        effect,
        evidence: runner.kind.describeSnapshot(live)
      })
    }
    if (
      getUnresolvedAttempts(this.dependencies.ledgerStore.read(runner.enrollment.watcherId))
        .length === 0
    ) {
      for (const trace of runner.traces) {
        if (!trace.pinned) {
          continue
        }
        this.dependencies.ledgerStore.releaseTickTracePin(runner.enrollment.watcherId, trace.seq)
        trace.pinned = false
      }
    }
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
    for (const attempt of attempts) {
      const latest = getLatestAttempts(
        this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
      ).find((candidate) => candidate.attemptId === attempt.attemptId)
      if (latest?.state !== 'attempted') {
        continue
      }
      this.append(runner, {
        ...latest,
        eventId: this.dependencies.createId(),
        atMs: this.dependencies.now(),
        state: 'settled',
        effect: 'not-landed',
        reason: 'dispatch-receipt-absent'
      })
    }
  }

  abandonPendingAttempts(runner: WatcherRunner, ledger: WatcherLedger): void {
    for (const attempt of getInFlightAttempts(ledger)) {
      if (attempt.state !== 'attempted') {
        continue
      }
      this.append(runner, {
        ...attempt,
        eventId: this.dependencies.createId(),
        atMs: this.dependencies.now(),
        state: 'settled',
        effect: 'not-landed',
        reason: 'workspace-moved'
      })
      this.abandonFingerprint(runner, attempt.fingerprint, 'workspace-moved')
    }
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
    verdict: Exclude<GateVerdict, { verdict: 'allow' }>
  ): void {
    const fingerprint = makeAttemptFingerprint(
      action.contentIdentity,
      action.kind,
      action.evidenceKey
    )
    this.abandonFingerprint(runner, fingerprint, 'gate-hold')
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
        reason: verdict.reason
      })
      if (verdict.escalation.foldCount === 1) {
        this.dependencies.notifyApproval?.(runner.enrollment, action)
      }
    }
  }

  private append(runner: WatcherRunner, entry: LedgerEntry): void {
    this.dependencies.ledgerStore.append(runner.enrollment.watcherId, entry)
  }
}
