import type {
  WatcherCommandResult,
  WatcherOwnerFence,
  WatcherWorker
} from '../../shared/fork-heimdall/fleet-types'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import {
  appendAnsweredQuestionTransitions,
  appendVoidedQuestionTransitions,
  voidUnanswerableQuestion as voidQuestionIfUnanswerable,
  type QuestionLedgerAccess
} from './question-resolution'
import type { EnrollmentControlChange, EnrollmentControlCommit } from './enrollment-store'
import type { HeimdallLedgerStore } from './ledger-store'
import type { WatcherControlEscalationLifecycle } from './control-escalation-lifecycle'
import type { WatcherRunnerLoop } from './runner-loop'
import type { WatcherRunner } from './runner-state'
import {
  CoordinatorSeatLostError,
  QuestionAlreadyAnsweredError,
  type HeimdallOrchestrationAdapter
} from './orchestration/orchestration-contract'
import { getErrorCode } from '../git/worktree-operation-options'

type QuestionControlDependencies = {
  ledger: HeimdallLedgerStore
  orchestration: HeimdallOrchestrationAdapter
  runnerLoop: WatcherRunnerLoop
  runner(watcherId: string): WatcherRunner | null
  escalations: Pick<
    WatcherControlEscalationLifecycle,
    'hasOpenWorkerQuestion' | 'latestAutomaticParkKind'
  >
  precondition(
    watcherId: string,
    expectedOwner: WatcherOwnerFence
  ): { enrollment: WatcherEnrollment } | WatcherCommandResult
  commit(
    watcherId: string,
    expectedOwner: WatcherOwnerFence,
    change: EnrollmentControlChange,
    appendWithinTransaction?: () => void
  ): EnrollmentControlCommit
  requireValidCommit(commit: EnrollmentControlCommit): WatcherEnrollment
  now(): number
  createId(): string
}

/** Owns worker-question ledger transitions and their owner-visible runner updates. */
export class WatcherQuestionControlLifecycle {
  constructor(private readonly dependencies: QuestionControlDependencies) {}

  async voidUnanswerableQuestion(enrollment: WatcherEnrollment): Promise<void> {
    await voidQuestionIfUnanswerable(
      this.questionLedger,
      (messageId) => this.dependencies.orchestration.readQuestion(enrollment, messageId),
      enrollment.watcherId,
      (dispatchId) =>
        this.dependencies.orchestration
          .readDispatch(enrollment, dispatchId)
          .then((observation) => observation.status)
    )
  }

  async answerQuestion(
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
    const ledgerStillPresentsQuestion = this.dependencies.escalations.hasOpenWorkerQuestion(
      enrollment.watcherId,
      messageId
    )
    if (!workerStillPresentsQuestion && !ledgerStillPresentsQuestion) {
      return refused('question-already-answered', `Question ${messageId} is no longer pending`)
    }
    const fence = this.dependencies.precondition(enrollment.watcherId, expectedOwner)
    if ('status' in fence) {
      return fence
    }
    const current = fence.enrollment
    const restoreAutoQuestionPark =
      !current.enabled &&
      !current.paused &&
      this.dependencies.escalations.latestAutomaticParkKind(
        this.dependencies.ledger.read(current.watcherId)
      ) === 'park-worker-question'
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
        const runner = this.dependencies.runner(current.watcherId)
        if (runner) {
          this.dependencies.runnerLoop.schedule(runner, 0)
        }
        return refused('question-already-answered', errorText(error))
      }
      return { status: 'indeterminate', detail: errorText(error) }
    }
    const commit = this.dependencies.commit(
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
    const updated = this.dependencies.requireValidCommit(commit)
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
    return { status: 'applied', appliedAtMs: this.dependencies.now() }
  }

  private get questionLedger(): QuestionLedgerAccess {
    return {
      read: (watcherId) => this.dependencies.ledger.read(watcherId),
      append: (entry) => this.dependencies.ledger.append(entry),
      now: this.dependencies.now,
      createId: this.dependencies.createId
    }
  }

  private preSendError(error: unknown): WatcherCommandResult {
    if (error instanceof CoordinatorSeatLostError || errorCode(error) === 'coordinator-seat-lost') {
      return refused('coordinator-seat-lost', errorText(error))
    }
    return refused('owner-unreachable', errorText(error))
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
