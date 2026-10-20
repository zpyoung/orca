import { deriveBudgetState } from '../../shared/fork-heimdall/budget'
import { WORKER_EXITED_WITHOUT_COMPLETION } from '../../shared/fork-heimdall/effect-certainty'
import {
  getInFlightAttempts,
  getLatestAttempts,
  getLatestEscalations,
  getUnresolvedAttempts,
  hasPendingAttemptOutcome
} from '../../shared/fork-heimdall/ledger-queries'
import type {
  EvidenceEntry,
  LedgerEntry,
  WatcherLedger
} from '../../shared/fork-heimdall/ledger-types'
import { errorBackoffMs, HEIMDALL_RAPID_POLL_MS } from '../../shared/fork-heimdall/pacing'
import type { WatcherTickTrace } from '../../shared/fork-heimdall/tick-trace'
import type { HeimdallOrchestrationAdapter } from './orchestration/orchestration-adapter'
import type { WatcherLedgerLifecycle } from './ledger-lifecycle'
import { getOpenWorkerQuestion, voidedWorkerQuestionEntries } from './question-resolution'
import { recordWorkerDeviationIfOwned } from './runner-worker-deviation'
import {
  hasSequenceSinceRunBoundary,
  mailboxBody,
  mailboxCursor,
  mailboxDeliveryCheckpoint
} from './runner-mailbox'
import type { WatcherRunnerStatusLifecycle } from './runner-status'
import type { RunnerLedgerStore, WatcherRunner } from './runner-state'
import { releaseSettledWorker } from './runner-worker-release'
import { resolveAcceptedCompletionEffect } from './runner-accepted-completion'
import { appendWorkerEscalation } from './worker-escalation-record'
import {
  parkedForWorkerQuestion,
  parseWorkerEscalationId,
  type WorkerReconciliation,
  unresolvedWorkerEscalations,
  workerEscalationMessageId,
  workerEscalationParkRecovered
} from './runner-worker-state'

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

/**
 * Reconciles worker mailbox/liveness state and applies the resulting runner transition.
 *
 * Every branch below used to return `null`, which skipped stop-policy evaluation and attempt
 * recovery for the rest of the tick (bug-146). Each now records its deviation (only when an owner
 * is configured — an unowned watcher's ledger stays exactly as before) and returns the ledger so the
 * caller keeps going; only `paused` additionally withholds the owner wake, via the enrollment check
 * `driveOwnerDeviation` itself applies.
 */
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
      if (hasPendingAttemptOutcome(ledger)) {
        this.dependencies.schedule(runner, HEIMDALL_RAPID_POLL_MS)
      }
      trace.exitPath = 'gate-held'
      return ledger
    }
    if (workerState.status === 'question') {
      const scoped = this.isDispatchScoped(runner, workerState.dispatchId, ledger)
      recordWorkerDeviationIfOwned(this.dependencies, runner, {
        kind: 'worker-question',
        messageId: workerState.messageId,
        dispatchId: workerState.dispatchId,
        question: 'Worker requested input'
      })
      if (scoped) {
        return this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
      }
      this.dependencies.statusLifecycle.park(runner, {
        kind: 'worker-question',
        messageId: workerState.messageId
      })
      trace.exitPath = 'gate-held'
      this.dependencies.schedule(runner, HEIMDALL_RAPID_POLL_MS)
      // re-read: park/deviation recording appended after `ledger`; a stale read here would let a
      // stop predicate re-fire on evidence it already consumed this tick
      return this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
    }
    if (workerState.status === 'escalation') {
      const scoped = this.isDispatchScoped(runner, workerState.dispatchId, ledger)
      recordWorkerDeviationIfOwned(this.dependencies, runner, {
        kind: 'worker-escalation',
        escalationId: workerState.escalationId,
        messageId: workerState.messageId,
        dispatchId: workerState.dispatchId,
        reason: workerState.reason
      })
      if (scoped) {
        return this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
      }
      this.dependencies.statusLifecycle.parkForWorkerEscalation(
        runner,
        workerState.escalationId,
        workerState.reason,
        workerState.messageId
      )
      trace.exitPath = 'gate-escalated'
      this.dependencies.schedule(runner, HEIMDALL_RAPID_POLL_MS)
      return this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
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
      recordWorkerDeviationIfOwned(this.dependencies, runner, {
        kind: 'worker-unverifiable',
        dispatchId: workerState.dispatchId,
        reason: workerState.reason
      })
      trace.exitPath = 'error'
      this.dependencies.schedule(
        runner,
        errorBackoffMs(runner.consecutiveErrors) ?? HEIMDALL_RAPID_POLL_MS
      )
      return this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
    }
    if (workerState.status === 'exited') {
      runner.forceFresh = true
      recordWorkerDeviationIfOwned(this.dependencies, runner, {
        kind: 'worker-exited',
        dispatchId: workerState.dispatchId,
        exitTail: null
      })
      trace.exitPath = 'watching'
      this.dependencies.schedule(runner, 0)
      return this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
    }
    return this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
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
      const eventRecorded = ledger.entries.some((current) => current.eventId === entry.eventId)
      if (entry.kind === 'evidence' && entry.source) {
        if (hasSequenceSinceRunBoundary(ledger, entry.source.sequence)) {
          continue
        }
        if (eventRecorded) {
          this.append(runner, mailboxDeliveryCheckpoint(entry))
          continue
        }
      } else if (eventRecorded) {
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
        await this.settleRunningWorker(
          runner,
          body.dispatchId,
          body.outcome,
          body.result ?? body.body,
          entry
        )
      }
    }

    const reconciliationLedger = this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
    const pendingDispatches = [
      ...getInFlightAttempts(reconciliationLedger),
      ...getUnresolvedAttempts(reconciliationLedger)
    ]
    const inspectedDispatches = new Set<string>()
    for (const pending of pendingDispatches) {
      if (!pending.dispatchId || inspectedDispatches.has(pending.dispatchId)) {
        continue
      }
      inspectedDispatches.add(pending.dispatchId)
      const report = await this.dependencies.orchestration.readAuthoritativeWorkerReport(
        runner.enrollment,
        pending.dispatchId
      )
      await this.assertLeaseHeld(runner)
      if (!report) {
        continue
      }
      const current = this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
      const completionRecorded = current.entries.some((entry) => entry.eventId === report.eventId)
      if (!completionRecorded) {
        this.append(runner, report)
      }
      const completion = mailboxBody(report)
      const latest = getLatestAttempts(current).find(
        (attempt) => attempt.dispatchId === pending.dispatchId
      )
      if (
        completion?.type === 'worker_done' &&
        completion.dispatchId === pending.dispatchId &&
        latest?.state === 'running'
      ) {
        await this.settleRunningWorker(
          runner,
          pending.dispatchId,
          completion.outcome,
          completion.result ?? completion.body,
          report
        )
      }
    }

    let currentLedger = this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
    const openQuestion = getOpenWorkerQuestion(currentLedger)
    const pendingMessageId = question?.messageId ?? openQuestion?.messageId ?? null
    const pendingQuestionDispatchId = question?.dispatchId ?? openQuestion?.dispatchId ?? null
    let pendingQuestion: { messageId: string; dispatchId: string | null } | null = null
    if (pendingMessageId) {
      // a question raised in this drain is answerable by definition; only a carried-over one can be void
      if (question || !(await this.voidUnanswerableQuestion(runner, pendingMessageId))) {
        pendingQuestion = {
          messageId: pendingMessageId,
          dispatchId: pendingQuestionDispatchId ?? null
        }
      } else {
        currentLedger = this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
      }
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
    let exitedDispatchId: string | null = null
    for (const attempt of inFlightAttempts) {
      if (attempt.state !== 'running' || !attempt.dispatchId) {
        continue
      }
      if (pendingQuestion?.dispatchId === attempt.dispatchId) {
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
        exitedDispatchId = attempt.dispatchId
      } else {
        this.dependencies.dispatchLifecycle.closeWorkerForContactLoss(
          runner.enrollment.watcherId,
          attempt.dispatchId
        )
        return {
          status: 'unverifiable',
          dispatchId: attempt.dispatchId,
          reason: observation.reason ?? 'Worker liveness could not be verified'
        }
      }
    }
    if (pendingQuestion) {
      return {
        status: 'question',
        messageId: pendingQuestion.messageId,
        dispatchId: pendingQuestion.dispatchId
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
          dispatchId: parseWorkerEscalationId(pendingEscalation.escalationId)?.dispatchId ?? null,
          reason: pendingEscalation.reason ?? 'Worker requested operator intervention'
        }
      : exited
        ? { status: 'exited', dispatchId: exitedDispatchId }
        : { status: 'clear' }
  }

  private async settleRunningWorker(
    runner: WatcherRunner,
    dispatchId: string,
    outcome: string | undefined,
    result: unknown,
    evidence: EvidenceEntry
  ): Promise<void> {
    const effect = await resolveAcceptedCompletionEffect(runner, this.dependencies.ledgerStore, {
      dispatchId,
      outcome,
      result,
      evidence
    })
    this.dependencies.dispatchLifecycle.settleWorker({
      watcherId: runner.enrollment.watcherId,
      dispatchId,
      // A failed outcome or unverified kind-owned completion still needs resolveOutcome to classify it.
      effect,
      ...(result === undefined ? {} : { result }),
      reason: outcome
    })
    await releaseSettledWorker(runner, dispatchId, this.dependencies)
    this.resolveWorkerEscalations(runner, dispatchId)
  }

  private appendWorkerEscalation(
    runner: WatcherRunner,
    input: { messageId: string; dispatchId?: string; reason: string }
  ): void {
    appendWorkerEscalation(this.dependencies, runner.enrollment.watcherId, input)
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

  private isDispatchScoped(
    runner: WatcherRunner,
    dispatchId: string | null,
    ledger: WatcherLedger
  ): boolean {
    if (!dispatchId || !runner.kind.concurrency) {
      return false
    }
    const attempt = getLatestAttempts(ledger).find(
      (candidate) => candidate.dispatchId === dispatchId
    )
    return attempt ? runner.kind.concurrency.isIsolatedAttempt(attempt, ledger) : false
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
