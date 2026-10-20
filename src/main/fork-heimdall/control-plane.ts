import { ApprovalScopeSchema } from '../../shared/fork-heimdall/gate'
import {
  WatcherCommandRequestSchema,
  type WatcherCommandRequest,
  type WatcherCommandResult,
  type WatcherOwnerFence
} from '../../shared/fork-heimdall/fleet-types'
import { getLatestApproval } from '../../shared/fork-heimdall/ledger-queries'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import { WatcherQuestionControlLifecycle } from './control-question-lifecycle'
import { WatcherEnrollmentControlLifecycle } from './control-enrollment-lifecycle'
import { WatcherDeletionLifecycle } from './control-delete-lifecycle'
import { WatcherControlEscalationLifecycle } from './control-escalation-lifecycle'
import {
  isMalformedKindPayloadEnrollment,
  type EnrollmentControlChange,
  type EnrollmentControlCommit,
  type EnrollmentRecord,
  type EnrollmentStore
} from './enrollment-store'
import { answerPipelineChoice, legacyPipelineApprovalRefusal } from './control-pipeline-choice'
import type { HeimdallLedgerStore } from './ledger-store'
import type { LeaseStore } from './lease-store'
import {
  CoordinatorSeatLostError,
  type HeimdallOrchestrationAdapter
} from './orchestration/orchestration-contract'
import type { WatcherRunnerLoop } from './runner-loop'
import type { WatcherRunner } from './runner-state'
import { getErrorCode } from '../git/worktree-operation-options'

type ControlPlaneDependencies = {
  enrollments: EnrollmentStore
  ledger: HeimdallLedgerStore
  lease: LeaseStore
  orchestration: HeimdallOrchestrationAdapter
  runnerLoop: WatcherRunnerLoop
  runner(watcherId: string): WatcherRunner | null
  removeRunner(watcherId: string): void
  purgeKindData(enrollment: EnrollmentRecord): Promise<void>
  owns(enrollment: EnrollmentRecord): boolean
  now(): number
  createId(): string
  changed(): void
}
export class WatcherControlPlane {
  private readonly operationTails = new Map<string, Promise<void>>()
  private readonly enrollmentLifecycle: WatcherEnrollmentControlLifecycle
  private readonly deletionLifecycle: WatcherDeletionLifecycle
  private readonly escalations: WatcherControlEscalationLifecycle
  private readonly questions: WatcherQuestionControlLifecycle

  constructor(private readonly dependencies: ControlPlaneDependencies) {
    this.escalations = new WatcherControlEscalationLifecycle({
      ledger: dependencies.ledger,
      now: dependencies.now,
      createId: dependencies.createId
    })
    this.questions = new WatcherQuestionControlLifecycle({
      ledger: dependencies.ledger,
      orchestration: dependencies.orchestration,
      runnerLoop: dependencies.runnerLoop,
      runner: dependencies.runner,
      escalations: this.escalations,
      precondition: (watcherId, expectedOwner) => this.precondition(watcherId, expectedOwner),
      commit: (watcherId, expectedOwner, change, appendWithinTransaction) =>
        this.commit(watcherId, expectedOwner, change, appendWithinTransaction),
      requireValidCommit: (commit) => this.requireValidCommit(commit),
      now: dependencies.now,
      createId: dependencies.createId
    })
    this.deletionLifecycle = new WatcherDeletionLifecycle({
      enrollments: dependencies.enrollments,
      lease: dependencies.lease,
      runnerControl: dependencies.runnerLoop.controlLifecycle,
      runner: dependencies.runner,
      removeRunner: dependencies.removeRunner,
      purgeKindData: dependencies.purgeKindData,
      owns: dependencies.owns,
      now: dependencies.now,
      changed: dependencies.changed
    })
    this.enrollmentLifecycle = new WatcherEnrollmentControlLifecycle({
      ledger: dependencies.ledger,
      lease: dependencies.lease,
      runnerLoop: dependencies.runnerLoop,
      runner: dependencies.runner,
      commit: (watcherId, expectedOwner, change, appendWithinTransaction) =>
        this.commit(watcherId, expectedOwner, change, appendWithinTransaction),
      requireValidCommit: (commit) => this.requireValidCommit(commit),
      latestHaltWasAutomaticPark: (ledger) =>
        this.escalations.latestAutomaticParkKind(ledger) !== null,
      appendResumeEscalationTransitions: (watcherId) =>
        this.escalations.appendResumeTransitions(watcherId),
      appendDisarmTransitions: (watcherId) => this.escalations.appendDisarmTransitions(watcherId),
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
    if (request.command.kind === 'delete') {
      return await this.deletionLifecycle.delete(request.target.watcherId, request.expectedOwner)
    }
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
        await this.questions.voidUnanswerableQuestion(enrollment)
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
      case 'set-concurrency':
        return this.enrollmentLifecycle.setConcurrency(
          enrollment,
          request.expectedOwner,
          request.command.maxConcurrency
        )
      case 'answer-question':
        return await this.questions.answerQuestion(
          enrollment,
          request.expectedOwner,
          request.command.messageId,
          request.command.body
        )
      case 'stop-worker':
        return await this.stopWorker(enrollment, request.expectedOwner, request.command.dispatchId)
      case 'answer-escalation':
        return this.answerEscalation(
          enrollment,
          request.expectedOwner,
          request.command.escalationId,
          request.command.body
        )
      case 'answer-pipeline-choice':
        return answerPipelineChoice(
          enrollment,
          request.expectedOwner,
          request.command,
          this.dependencies,
          this.escalations
        )
    }
  }

  private answerEscalation(
    enrollment: WatcherEnrollment,
    expectedOwner: WatcherOwnerFence,
    escalationId: string,
    body: string
  ): WatcherCommandResult {
    const preparation = this.escalations.prepareAnswerEscalation(
      enrollment.watcherId,
      escalationId,
      body
    )
    if (preparation.status === 'refused') {
      return refused('invalid-state', preparation.detail)
    }
    const commit = this.commit(
      enrollment.watcherId,
      expectedOwner,
      { enabled: true },
      preparation.apply
    )
    if (commit.status === 'refused') {
      return commit
    }
    const updated = this.requireValidCommit(commit)
    const runner = this.dependencies.runner(updated.watcherId)
    if (runner) {
      runner.enrollment = updated
      runner.status = {
        ...runner.status,
        enabled: true,
        state: 'watching',
        phase: 'operator-answered',
        reason: null,
        parkReason: null
      }
      this.dependencies.runnerLoop.schedule(runner, 0)
    }
    return this.applied()
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
    const pipelineRefusal = legacyPipelineApprovalRefusal(scope.data)
    if (pipelineRefusal) {
      return pipelineRefusal
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
      this.escalations.appendApprovalResolution(enrollment.watcherId, scope.data)
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
  return getErrorCode(error) ?? null
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
