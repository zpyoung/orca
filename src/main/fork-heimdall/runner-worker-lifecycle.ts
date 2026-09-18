import { deriveBudgetState } from '../../shared/fork-heimdall/budget'
import { WORKER_EXITED_WITHOUT_COMPLETION } from '../../shared/fork-heimdall/effect-certainty'
import {
  getInFlightAttempts,
  getLatestAttempts,
  getLatestEscalations
} from '../../shared/fork-heimdall/ledger-queries'
import type {
  EscalationEntry,
  LedgerEntry,
  WatcherLedger
} from '../../shared/fork-heimdall/ledger-types'
import { errorBackoffMs, HEIMDALL_RAPID_POLL_MS } from '../../shared/fork-heimdall/pacing'
import { parkedWorkerEscalationId } from '../../shared/fork-heimdall/park-escalation-id'
import type { WatcherTickTrace } from '../../shared/fork-heimdall/tick-trace'
import type { HeimdallOrchestrationAdapter } from './orchestration/orchestration-adapter'
import type { WatcherLedgerLifecycle } from './ledger-lifecycle'
import { getOpenWorkerQuestion, voidedWorkerQuestionEntries } from './question-resolution'
import { hasSequenceSinceRunBoundary, mailboxBody, mailboxCursor } from './runner-mailbox'
import type { WatcherRunnerStatusLifecycle } from './runner-status'
import type { RunnerLedgerStore, WatcherRunner } from './runner-state'
import { releaseSettledWorker } from './runner-worker-release'

/**
 * The watcher's most recent halt when it was an automatic park, or null once a later disarm
 * supersedes it — the same status-agnostic "latest halt" check the human resume command uses.
 */
function latestAutomaticPark(ledger: WatcherLedger): EscalationEntry | null {
  const halt = ledger.entries.findLast(
    (entry) =>
      entry.kind === 'escalation' &&
      (entry.escalationKind.startsWith('park-') || entry.escalationKind === 'control-disarm')
  )
  return halt?.kind === 'escalation' && halt.escalationKind.startsWith('park-') ? halt : null
}

export function parkedForWorkerQuestion(ledger: WatcherLedger): boolean {
  return latestAutomaticPark(ledger)?.escalationKind === 'park-worker-question'
}

/**
 * Whether a worker-escalation park has become self-clearing: the escalation that caused it is no
 * longer unresolved and the dispatch that raised it settled as landed. A dispatch that failed or
 * was confirmed exited stays parked, so an operator still reads the report that went wrong.
 */
export function workerEscalationParkRecovered(ledger: WatcherLedger): boolean {
  const park = latestAutomaticPark(ledger)
  if (
    park?.escalationKind !== 'park-worker-escalation' ||
    unresolvedWorkerEscalations(ledger).length > 0
  ) {
    return false
  }
  const escalationId = parkedWorkerEscalationId(park.watcherId, park.escalationId)
  const dispatchId = escalationId ? parseWorkerEscalationId(escalationId)?.dispatchId : null
  return (
    dispatchId !== null &&
    dispatchId !== undefined &&
    getLatestAttempts(ledger).some(
      (attempt) =>
        attempt.dispatchId === dispatchId &&
        attempt.state === 'settled' &&
        attempt.effect === 'landed'
    )
  )
}

function unresolvedWorkerEscalations(ledger: WatcherLedger): readonly EscalationEntry[] {
  return getLatestEscalations(ledger).filter(
    (entry) =>
      entry.escalationKind === 'worker-escalation' &&
      (entry.status === 'open' || entry.status === 'escalated')
  )
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

/** Inverts appendWorkerEscalation's `worker-escalation:<dispatchId>:<messageId>` encoding. */
function parseWorkerEscalationId(
  escalationId: string
): { dispatchId: string | null; messageId: string | null } | null {
  const parts = escalationId.split(':')
  if (parts.length !== 3 || parts[0] !== 'worker-escalation') {
    return null
  }
  return { dispatchId: decodeSegment(parts[1]), messageId: decodeSegment(parts[2]) }
}

function workerEscalationMessageId(escalationId: string): string {
  return parseWorkerEscalationId(escalationId)?.messageId ?? escalationId
}

type WorkerReconciliation =
  | { status: 'clear' }
  | { status: 'question'; messageId: string }
  | { status: 'escalation'; escalationId: string; messageId: string; reason: string }
  | { status: 'exited' }
  | { status: 'unverifiable'; reason: string }

export type WatcherRunnerWorkerLifecycleDependencies = {
  ledgerStore: RunnerLedgerStore
  orchestration: HeimdallOrchestrationAdapter
  dispatchLifecycle: WatcherLedgerLifecycle
  statusLifecycle: Pick<
    WatcherRunnerStatusLifecycle,
    'park' | 'parkForWorkerEscalation' | 'readyToResume'
  >
  schedule(runner: WatcherRunner, delayMs: number): void
  publish(runner: WatcherRunner): void
  now(): number
  createId(): string
}

/** Reconciles worker mailbox/liveness state and applies the resulting runner transition. */
export class WatcherRunnerWorkerLifecycle {
  constructor(private readonly dependencies: WatcherRunnerWorkerLifecycleDependencies) {}

  async refresh(runner: WatcherRunner, trace: WatcherTickTrace): Promise<WatcherLedger | null> {
    const workerState = await this.reconcileWorkers(runner)
    const ledger = this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
    if (runner.enrollment.paused) {
      runner.status = {
        ...runner.status,
        enabled: true,
        state: 'held',
        phase: 'paused',
        reason: 'paused',
        nextPulseAtMs: null
      }
      this.dependencies.publish(runner)
      if (getInFlightAttempts(ledger).some((attempt) => attempt.state === 'running')) {
        this.dependencies.schedule(runner, HEIMDALL_RAPID_POLL_MS)
      }
      trace.exitPath = 'gate-held'
      return null
    }
    if (workerState.status === 'question') {
      this.dependencies.statusLifecycle.park(runner, {
        kind: 'worker-question',
        messageId: workerState.messageId
      })
      trace.exitPath = 'gate-held'
      this.dependencies.schedule(runner, HEIMDALL_RAPID_POLL_MS)
      return null
    }
    if (workerState.status === 'escalation') {
      this.dependencies.statusLifecycle.parkForWorkerEscalation(
        runner,
        workerState.escalationId,
        workerState.reason,
        workerState.messageId
      )
      trace.exitPath = 'gate-escalated'
      this.dependencies.schedule(runner, HEIMDALL_RAPID_POLL_MS)
      return null
    }
    if (
      !runner.enrollment.enabled &&
      !deriveBudgetState(ledger, runner.enrollment.budget).exhausted
    ) {
      if (parkedForWorkerQuestion(ledger) && !getOpenWorkerQuestion(ledger)) {
        this.dependencies.statusLifecycle.readyToResume(runner, 'park-worker-question')
      } else if (workerEscalationParkRecovered(ledger)) {
        this.dependencies.statusLifecycle.readyToResume(runner, 'park-worker-escalation')
      }
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
      this.dependencies.publish(runner)
      trace.exitPath = 'error'
      this.dependencies.schedule(
        runner,
        errorBackoffMs(runner.consecutiveErrors) ?? HEIMDALL_RAPID_POLL_MS
      )
      return null
    }
    if (workerState.status === 'exited') {
      runner.forceFresh = true
      trace.exitPath = 'watching'
      this.dependencies.schedule(runner, 0)
      return null
    }
    return ledger
  }

  private async reconcileWorkers(runner: WatcherRunner): Promise<WorkerReconciliation> {
    const ledger = this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
    const entries = await this.dependencies.orchestration.drainMailbox({
      enrollment: runner.enrollment,
      cursor: mailboxCursor(ledger)
    })
    await this.assertLeaseHeld(runner)
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
      if (body.type === 'escalation') {
        const subject = body.subject?.trim() || undefined
        const detail = body.body?.trim() || undefined
        this.appendWorkerEscalation(runner, {
          messageId: body.messageId ?? entry.eventId,
          ...(body.dispatchId ? { dispatchId: body.dispatchId } : {}),
          reason:
            subject && detail
              ? `${subject}: ${detail}`
              : (subject ?? detail ?? 'Worker requested operator intervention')
        })
        if (body.dispatchId) {
          this.dependencies.dispatchLifecycle.pauseWorker(
            runner.enrollment.watcherId,
            body.dispatchId
          )
        }
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
          // a failed outcome still needs resolveOutcome to read the report and classify why
          effect: body.outcome === 'succeeded' ? 'landed' : 'indeterminate',
          result: body.result ?? body.body,
          reason: body.outcome
        })
        await releaseSettledWorker(runner, body.dispatchId, this.dependencies)
        this.resolveWorkerEscalations(runner, body.dispatchId)
      }
    }

    let currentLedger = this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
    const pendingMessageId =
      question?.messageId ?? getOpenWorkerQuestion(currentLedger)?.messageId ?? null
    if (pendingMessageId) {
      // a question raised in this drain is answerable by definition; only a carried-over one can be void
      if (question || !(await this.voidUnanswerableQuestion(runner, pendingMessageId))) {
        return { status: 'question', messageId: pendingMessageId }
      }
      currentLedger = this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
    }
    const workerEscalations = unresolvedWorkerEscalations(currentLedger)
    const inFlightAttempts = getInFlightAttempts(currentLedger)
    const escalatedDispatchIds = new Set<string>()
    for (const attempt of inFlightAttempts) {
      const dispatchId = attempt.dispatchId
      if (
        attempt.state !== 'running' ||
        !dispatchId ||
        !workerEscalations.some((entry) =>
          entry.escalationId.startsWith(`worker-escalation:${encodeURIComponent(dispatchId)}:`)
        )
      ) {
        continue
      }
      escalatedDispatchIds.add(dispatchId)
      this.dependencies.dispatchLifecycle.pauseWorker(runner.enrollment.watcherId, dispatchId)
    }

    let exited = false
    for (const attempt of inFlightAttempts) {
      if (attempt.state !== 'running' || !attempt.dispatchId) {
        continue
      }
      const observation = await this.dependencies.orchestration.readDispatch(
        runner.enrollment,
        attempt.dispatchId
      )
      await this.assertLeaseHeld(runner)
      if (observation.status === 'live') {
        if (!escalatedDispatchIds.has(attempt.dispatchId)) {
          this.dependencies.dispatchLifecycle.observeWorkerLive(
            runner.enrollment.watcherId,
            attempt.dispatchId
          )
        }
      } else if (observation.status === 'exited') {
        this.dependencies.dispatchLifecycle.settleWorker({
          watcherId: runner.enrollment.watcherId,
          dispatchId: attempt.dispatchId,
          effect: 'indeterminate',
          reason: WORKER_EXITED_WITHOUT_COMPLETION
        })
        await releaseSettledWorker(runner, attempt.dispatchId, this.dependencies)
        this.resolveWorkerEscalations(runner, attempt.dispatchId)
        exited = true
      } else {
        this.dependencies.dispatchLifecycle.closeForContactLoss(runner.enrollment.watcherId)
        return {
          status: 'unverifiable',
          reason: observation.reason ?? 'Worker liveness could not be verified'
        }
      }
    }
    const pendingEscalation = unresolvedWorkerEscalations(
      this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
    ).at(-1)
    return pendingEscalation
      ? {
          status: 'escalation',
          escalationId: pendingEscalation.escalationId,
          messageId: workerEscalationMessageId(pendingEscalation.escalationId),
          reason: pendingEscalation.reason ?? 'Worker requested operator intervention'
        }
      : exited
        ? { status: 'exited' }
        : { status: 'clear' }
  }

  private appendWorkerEscalation(
    runner: WatcherRunner,
    input: { messageId: string; dispatchId?: string; reason: string }
  ): void {
    const escalationId = `worker-escalation:${encodeURIComponent(
      input.dispatchId ?? 'unknown'
    )}:${encodeURIComponent(input.messageId)}`
    if (
      getLatestEscalations(this.dependencies.ledgerStore.read(runner.enrollment.watcherId)).some(
        (entry) => entry.escalationId === escalationId
      )
    ) {
      return
    }
    this.append(runner, {
      eventId: this.dependencies.createId(),
      watcherId: runner.enrollment.watcherId,
      atMs: this.dependencies.now(),
      origin: 'owner',
      class: 'fact',
      kind: 'escalation',
      escalationId,
      escalationKind: 'worker-escalation',
      status: 'open',
      foldCount: 1,
      reason: input.reason
    })
  }

  private resolveWorkerEscalations(runner: WatcherRunner, dispatchId: string): void {
    const prefix = `worker-escalation:${encodeURIComponent(dispatchId)}:`
    for (const entry of getLatestEscalations(
      this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
    )) {
      if (
        (entry.status !== 'open' && entry.status !== 'escalated') ||
        entry.escalationKind !== 'worker-escalation' ||
        !entry.escalationId.startsWith(prefix)
      ) {
        continue
      }
      this.append(runner, {
        ...entry,
        eventId: this.dependencies.createId(),
        atMs: this.dependencies.now(),
        status: 'resolved',
        foldCount: entry.foldCount + 1
      })
    }
  }

  /** Retires a carried-over question whose thread can no longer accept an answer. */
  private async voidUnanswerableQuestion(
    runner: WatcherRunner,
    messageId: string
  ): Promise<boolean> {
    const state = await this.dependencies.orchestration.readQuestion(runner.enrollment, messageId)
    if (state.status === 'pending' || state.status === 'unverifiable') {
      return false
    }
    const entries = voidedWorkerQuestionEntries(
      this.dependencies.ledgerStore.read(runner.enrollment.watcherId),
      runner.enrollment.watcherId,
      messageId,
      state.status,
      { atMs: this.dependencies.now(), createId: this.dependencies.createId }
    )
    for (const entry of entries) {
      this.append(runner, entry)
    }
    return entries.length > 0
  }

  private async assertLeaseHeld(runner: WatcherRunner): Promise<void> {
    if (!runner.leaseGuard) {
      throw new Error('Watcher reconciliation reached persistence without a lease')
    }
    await runner.leaseGuard.assertHeld()
  }

  private append(runner: WatcherRunner, entry: LedgerEntry): void {
    this.dependencies.ledgerStore.append(runner.enrollment.watcherId, entry)
  }
}
