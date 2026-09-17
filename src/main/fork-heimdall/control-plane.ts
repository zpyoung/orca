import { ApprovalScopeSchema } from '../../shared/fork-heimdall/gate'
import {
  WatcherCommandRequestSchema,
  type WatcherCommandRequest,
  type WatcherCommandResult,
  type WatcherOwnerFence,
  type WatcherWorker
} from '../../shared/fork-heimdall/fleet-types'
import { getLatestApproval, getLatestEscalations } from '../../shared/fork-heimdall/ledger-queries'
import type { ApprovalScope, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import { getApprovalEscalationsToResolve } from './approval-resolution'
import {
  appendAnsweredQuestionTransitions,
  appendVoidedQuestionTransitions,
  voidUnanswerableQuestion,
  type QuestionLedgerAccess
} from './question-resolution'
import { WatcherEnrollmentControlLifecycle } from './control-enrollment-lifecycle'
import {
  isMalformedKindPayloadEnrollment,
  type EnrollmentControlChange,
  type EnrollmentControlCommit,
  type EnrollmentRecord,
  type EnrollmentStore
} from './enrollment-store'
import type { HeimdallLedgerStore } from './ledger-store'
import type { LeaseStore } from './lease-store'
import {
  CoordinatorSeatLostError,
  QuestionAlreadyAnsweredError,
  type HeimdallOrchestrationAdapter
} from './orchestration/orchestration-contract'
import type { WatcherRunnerLoop } from './runner-loop'
import type { WatcherRunner } from './runner-state'

type ControlPlaneDependencies = {
  enrollments: EnrollmentStore
  ledger: HeimdallLedgerStore
  lease: LeaseStore
  orchestration: HeimdallOrchestrationAdapter
  runnerLoop: WatcherRunnerLoop
  runner(watcherId: string): WatcherRunner | null
  owns(enrollment: EnrollmentRecord): boolean
  now(): number
  createId(): string
  changed(): void
}

export class WatcherControlPlane {
  private readonly operationTails = new Map<string, Promise<void>>()
  private readonly enrollmentLifecycle: WatcherEnrollmentControlLifecycle

  constructor(private readonly dependencies: ControlPlaneDependencies) {
    this.enrollmentLifecycle = new WatcherEnrollmentControlLifecycle({
      ledger: dependencies.ledger,
      lease: dependencies.lease,
      runnerLoop: dependencies.runnerLoop,
      runner: dependencies.runner,
      commit: (watcherId, expectedOwner, change, appendWithinTransaction) =>
        this.commit(watcherId, expectedOwner, change, appendWithinTransaction),
      requireValidCommit: (commit) => this.requireValidCommit(commit),
      latestHaltWasAutomaticPark: (ledger) => this.latestAutomaticParkKind(ledger) !== null,
      appendOpenParkAcknowledgements: (watcherId) => this.appendOpenParkAcknowledgements(watcherId),
      appendDisarmTransitions: (watcherId) => this.appendDisarmTransitions(watcherId),
      now: dependencies.now
    })
  }

  command(untrustedRequest: WatcherCommandRequest): Promise<WatcherCommandResult> {
    const parsed = WatcherCommandRequestSchema.safeParse(untrustedRequest)
    if (!parsed.success) {
      return Promise.resolve(
        refused('invalid-command', `Invalid Heimdall command: ${parsed.error.message}`)
      )
    }
    const request = parsed.data
    if (request.target.connectionId !== null || request.target.pairingRevision !== null) {
      return Promise.resolve(
        refused('unsupported-capability', 'The local owner cannot execute a remote watcher target')
      )
    }
    return this.serialized(request.target.watcherId, () => this.apply(request))
  }

  hasPendingOperation(watcherId: string): boolean {
    return this.operationTails.has(watcherId)
  }

  private serialized(
    watcherId: string,
    operation: () => Promise<WatcherCommandResult>
  ): Promise<WatcherCommandResult> {
    const previous = this.operationTails.get(watcherId) ?? Promise.resolve()
    const result: Promise<WatcherCommandResult> = previous
      .catch(() => undefined)
      .then(operation)
      .catch((error: unknown) => ({ status: 'indeterminate', detail: errorText(error) }))
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    this.operationTails.set(watcherId, tail)
    void tail.finally(() => {
      if (this.operationTails.get(watcherId) === tail) {
        this.operationTails.delete(watcherId)
      }
    })
    return result
  }

  private async apply(request: WatcherCommandRequest): Promise<WatcherCommandResult> {
    const precondition = this.precondition(request.target.watcherId, request.expectedOwner)
    if ('status' in precondition) {
      return precondition
    }
    const enrollment = precondition.enrollment
    switch (request.command.kind) {
      case 'pause':
        return await this.enrollmentLifecycle.pause(enrollment, request.expectedOwner)
      case 'resume':
        // a question its worker can no longer answer must not keep refusing the only recovery
        await voidUnanswerableQuestion(
          this.questionLedger,
          this.readQuestion(enrollment),
          enrollment.watcherId
        )
        return this.enrollmentLifecycle.resume(enrollment, request.expectedOwner)
      case 'disarm':
        return await this.enrollmentLifecycle.disarm(enrollment, request.expectedOwner)
      case 'approve':
        return this.approve(enrollment, request.expectedOwner, request.command.scope)
      case 'adjust-budget':
        return this.enrollmentLifecycle.adjustBudget(
          enrollment,
          request.expectedOwner,
          request.command.budget
        )
      case 'answer-question':
        return await this.answerQuestion(
          enrollment,
          request.expectedOwner,
          request.command.messageId,
          request.command.body
        )
      case 'stop-worker':
        return await this.stopWorker(enrollment, request.expectedOwner, request.command.dispatchId)
    }
  }

  private approve(
    enrollment: WatcherEnrollment,
    expectedOwner: WatcherOwnerFence,
    untrustedScope: unknown
  ): WatcherCommandResult {
    if (!enrollment.enabled || enrollment.paused) {
      return refused('invalid-state', 'A disabled or paused watcher cannot consume an approval')
    }
    const scope = ApprovalScopeSchema.safeParse(untrustedScope)
    if (!scope.success) {
      return refused('invalid-command', scope.error.message)
    }
    const previous = getLatestApproval(
      this.dependencies.ledger.read(enrollment.watcherId),
      scope.data
    )
    const commit = this.commit(enrollment.watcherId, expectedOwner, {}, () => {
      this.dependencies.ledger.append({
        eventId: this.dependencies.createId(),
        watcherId: enrollment.watcherId,
        atMs: this.dependencies.now(),
        origin: 'owner',
        class: 'fact',
        kind: 'approval',
        scope: scope.data,
        decision: 'approved',
        foldCount: (previous?.foldCount ?? 0) + 1
      })
      this.appendApprovalResolutionTransitions(enrollment.watcherId, scope.data)
    })
    if (commit.status === 'refused') {
      return commit
    }
    const runner = this.dependencies.runner(enrollment.watcherId)
    if (runner) {
      runner.enrollment = this.requireValidCommit(commit)
      this.dependencies.runnerLoop.schedule(runner, 0)
    }
    return this.applied()
  }

  private async answerQuestion(
    enrollment: WatcherEnrollment,
    expectedOwner: WatcherOwnerFence,
    messageId: string,
    body: string
  ): Promise<WatcherCommandResult> {
    let workers: WatcherWorker[]
    try {
      workers = await this.dependencies.orchestration.listWorkers(enrollment)
    } catch (error) {
      return this.preSendError(error)
    }
    const workerStillPresentsQuestion = workers.some(
      (worker) => worker.question?.messageId === messageId
    )
    const ledgerStillPresentsQuestion = this.hasOpenWorkerQuestion(enrollment.watcherId, messageId)
    if (!workerStillPresentsQuestion && !ledgerStillPresentsQuestion) {
      return refused('question-already-answered', `Question ${messageId} is no longer pending`)
    }
    const fence = this.precondition(enrollment.watcherId, expectedOwner)
    if ('status' in fence) {
      return fence
    }
    const current = fence.enrollment
    const restoreAutoQuestionPark =
      !current.enabled &&
      !current.paused &&
      this.latestHaltWasAutomaticQuestionPark(this.dependencies.ledger.read(current.watcherId))
    try {
      await this.dependencies.orchestration.answerQuestion(current, messageId, body)
    } catch (error) {
      if (
        error instanceof QuestionAlreadyAnsweredError ||
        errorCode(error) === 'question-already-answered' ||
        errorCode(error) === 'question_not_found'
      ) {
        return refused('question-already-answered', errorText(error))
      }
      if (
        error instanceof CoordinatorSeatLostError ||
        errorCode(error) === 'coordinator-seat-lost'
      ) {
        return refused('coordinator-seat-lost', errorText(error))
      }
      if (errorCode(error) === 'dispatch_inactive') {
        appendVoidedQuestionTransitions(this.questionLedger, current.watcherId, messageId, 'closed')
        return refused('question-already-answered', errorText(error))
      }
      return { status: 'indeterminate', detail: errorText(error) }
    }
    const commit = this.commit(
      current.watcherId,
      expectedOwner,
      restoreAutoQuestionPark ? { enabled: true } : {},
      () => appendAnsweredQuestionTransitions(this.questionLedger, current.watcherId, messageId)
    )
    if (commit.status === 'refused') {
      return {
        status: 'indeterminate',
        detail: `Question was answered but owner state could not be committed: ${commit.detail}`
      }
    }
    const updated = this.requireValidCommit(commit)
    const runner = this.dependencies.runner(updated.watcherId)
    if (runner) {
      runner.enrollment = updated
      runner.status = updated.paused
        ? {
            ...runner.status,
            enabled: true,
            state: 'held',
            phase: 'paused',
            reason: 'paused',
            nextPulseAtMs: null
          }
        : updated.enabled
          ? {
              ...runner.status,
              enabled: true,
              state: 'watching',
              phase: 'question-answered',
              reason: null,
              parkReason: null
            }
          : {
              ...runner.status,
              enabled: false,
              state: 'parked',
              phase: 'parked',
              reason: 'ready-to-resume',
              parkReason: null
            }
      this.dependencies.runnerLoop.schedule(runner, 0)
    }
    return this.applied()
  }

  private async stopWorker(
    enrollment: WatcherEnrollment,
    expectedOwner: WatcherOwnerFence,
    dispatchId: string
  ): Promise<WatcherCommandResult> {
    const fence = this.precondition(enrollment.watcherId, expectedOwner)
    if ('status' in fence) {
      return fence
    }
    const current = fence.enrollment
    let result: WatcherCommandResult
    try {
      result = await this.dependencies.orchestration.stopWorker(current, dispatchId)
    } catch (error) {
      if (
        error instanceof CoordinatorSeatLostError ||
        errorCode(error) === 'coordinator-seat-lost'
      ) {
        return refused('coordinator-seat-lost', errorText(error))
      }
      return { status: 'indeterminate', detail: errorText(error) }
    }
    if (result.status !== 'applied') {
      return result
    }
    const commit = this.commit(current.watcherId, expectedOwner, {})
    if (commit.status === 'refused') {
      return {
        status: 'indeterminate',
        detail: `Worker stop was confirmed but owner state could not be committed: ${commit.detail}`
      }
    }
    const runner = this.dependencies.runner(current.watcherId)
    if (runner) {
      runner.enrollment = this.requireValidCommit(commit)
      runner.forceFresh = true
      this.dependencies.runnerLoop.schedule(runner, 0)
    }
    return this.applied()
  }

  /** The kind of the newest halt escalation, or null when the newest halt was an explicit disarm. */
  private latestAutomaticParkKind(ledger: WatcherLedger): string | null {
    const halt = ledger.entries
      .toReversed()
      .find(
        (entry) =>
          entry.kind === 'escalation' &&
          (entry.escalationKind.startsWith('park-') || entry.escalationKind === 'control-disarm')
      )
    return halt?.kind === 'escalation' && halt.escalationKind.startsWith('park-')
      ? halt.escalationKind
      : null
  }

  private latestHaltWasAutomaticQuestionPark(ledger: WatcherLedger): boolean {
    return this.latestAutomaticParkKind(ledger) === 'park-worker-question'
  }

  private hasOpenWorkerQuestion(watcherId: string, messageId: string): boolean {
    return getLatestEscalations(this.dependencies.ledger.read(watcherId)).some(
      (entry) =>
        entry.status === 'open' &&
        entry.escalationKind === 'worker-question' &&
        entry.escalationId.endsWith(`:${messageId}`)
    )
  }

  private appendApprovalResolutionTransitions(watcherId: string, scope: ApprovalScope): void {
    for (const entry of getApprovalEscalationsToResolve(
      this.dependencies.ledger.read(watcherId),
      scope
    )) {
      this.dependencies.ledger.append({
        ...entry,
        eventId: this.dependencies.createId(),
        atMs: this.dependencies.now(),
        status: 'resolved',
        foldCount: entry.foldCount + 1
      })
    }
  }

  private get questionLedger(): QuestionLedgerAccess {
    return {
      read: (watcherId) => this.dependencies.ledger.read(watcherId),
      append: (entry) => this.dependencies.ledger.append(entry),
      now: this.dependencies.now,
      createId: this.dependencies.createId
    }
  }

  private readQuestion(enrollment: WatcherEnrollment) {
    return (messageId: string) =>
      this.dependencies.orchestration.readQuestion(enrollment, messageId)
  }

  private appendOpenParkAcknowledgements(watcherId: string): void {
    for (const entry of getLatestEscalations(this.dependencies.ledger.read(watcherId))) {
      if (entry.status !== 'open' || !entry.escalationKind.startsWith('park-')) {
        continue
      }
      this.dependencies.ledger.append({
        ...entry,
        eventId: this.dependencies.createId(),
        atMs: this.dependencies.now(),
        status: 'acknowledged',
        foldCount: entry.foldCount + 1
      })
    }
  }

  private appendDisarmTransitions(watcherId: string): void {
    for (const entry of getLatestEscalations(this.dependencies.ledger.read(watcherId))) {
      if (entry.status !== 'open') {
        continue
      }
      this.dependencies.ledger.append({
        ...entry,
        eventId: this.dependencies.createId(),
        atMs: this.dependencies.now(),
        status: 'resolved',
        foldCount: entry.foldCount + 1
      })
    }
    this.dependencies.ledger.append({
      eventId: this.dependencies.createId(),
      watcherId,
      atMs: this.dependencies.now(),
      origin: 'owner',
      class: 'fact',
      kind: 'escalation',
      escalationId: `control-disarm:${watcherId}:${this.dependencies.createId()}`,
      escalationKind: 'control-disarm',
      status: 'resolved',
      foldCount: 1,
      reason: 'explicit-disarm'
    })
  }

  private precondition(
    watcherId: string,
    expectedOwner: WatcherOwnerFence
  ): { enrollment: WatcherEnrollment } | WatcherCommandResult {
    const record = this.dependencies.enrollments.get(watcherId)
    if (!record) {
      return refused('watcher-not-found', `Heimdall watcher ${watcherId} was not found`)
    }
    if (!this.dependencies.owns(record)) {
      return refused('owner-conflict', `This process does not own Heimdall watcher ${watcherId}`)
    }
    if (
      record.executionHostId !== expectedOwner.executionHostId ||
      record.schedulerOwner !== expectedOwner.schedulerOwner ||
      record.workspaceKey !== expectedOwner.workspaceKey
    ) {
      return refused('owner-conflict', `Heimdall watcher ${watcherId} changed owner`)
    }
    if (record.commandRevision !== expectedOwner.revision) {
      return refused(
        'stale-revision',
        `Heimdall watcher ${watcherId} advanced to revision ${record.commandRevision}`
      )
    }
    if (record.terminalAtMs !== null) {
      return refused('invalid-state', `Heimdall watcher ${watcherId} is terminal`)
    }
    if (isMalformedKindPayloadEnrollment(record)) {
      return refused('invalid-state', `Heimdall watcher ${watcherId} has malformed owner state`)
    }
    return { enrollment: record }
  }

  private commit(
    watcherId: string,
    expectedOwner: WatcherOwnerFence,
    change: EnrollmentControlChange,
    appendWithinTransaction?: () => void
  ): EnrollmentControlCommit {
    const commit = this.dependencies.enrollments.commitControl(
      watcherId,
      expectedOwner,
      change,
      appendWithinTransaction
    )
    if (commit.status === 'committed') {
      this.dependencies.changed()
    }
    return commit
  }

  private requireValidCommit(commit: EnrollmentControlCommit): WatcherEnrollment {
    if (commit.status !== 'committed' || isMalformedKindPayloadEnrollment(commit.enrollment)) {
      throw new Error('A control mutation produced an invalid Heimdall enrollment')
    }
    return commit.enrollment
  }

  private preSendError(error: unknown): WatcherCommandResult {
    if (error instanceof CoordinatorSeatLostError || errorCode(error) === 'coordinator-seat-lost') {
      return refused('coordinator-seat-lost', errorText(error))
    }
    return refused('owner-unreachable', errorText(error))
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

function errorCode(error: unknown): string | null {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : null
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
