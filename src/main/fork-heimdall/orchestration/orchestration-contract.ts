import { createHash } from 'node:crypto'
import type {
  DispatchResult,
  DispatchWorkerInput
} from '../../../shared/fork-heimdall/kind-contract'
import type { WatcherCommandResult, WatcherWorker } from '../../../shared/fork-heimdall/fleet-types'
import type { EvidenceEntry, LedgerEntry } from '../../../shared/fork-heimdall/ledger-types'
import type { WatcherEnrollment } from '../../../shared/fork-heimdall/watcher-types'
import type { WorkerReleaseReceipt } from '../../runtime/rpc/methods/orchestration/worker/worker-release-completion'
import type { MailboxDrainInput } from './mailbox-drain'

export type HeimdallOrchestrationPersistence = {
  persistOrchestrationRunId(watcherId: string, runId: string): Promise<void>
}

export type DispatchObservation =
  | { status: 'live' }
  | { status: 'exited' }
  | { status: 'unverifiable'; reason?: string }

export type RecoverDispatchResult = DispatchResult | { status: 'absent' }

/** The worker's most recent assistant text, redacted and clipped to its newest bytes. */
export type WorkerLastMessage = { text: string; truncated: boolean }

/**
 * Whether a supervised worker has gone quiet at its prompt. Only an exact, live, local terminal
 * worker can be `idle`; SSH, federated, structured or unproven workers are `unavailable`, never idle.
 */
export type WorkerIdleObservation =
  | {
      status: 'idle'
      activity: 'waiting' | 'done'
      idleSinceMs: number
      lastMessage: WorkerLastMessage | null
    }
  | { status: 'active' }
  | { status: 'unavailable'; reason: string }

/**
 * Whether a worker question can still receive an answer. `answered`, `closed` and `absent` are all
 * unanswerable: orchestration refuses `answerQuestion` on each, so an escalation still demanding one
 * can never be cleared by a human. `unverifiable` is not settlement — the caller must leave it open.
 */
export type WatcherQuestionState =
  | { status: 'pending' }
  | { status: 'answered' }
  | { status: 'closed' }
  | { status: 'absent' }
  | { status: 'unverifiable'; reason: string }

export type UnanswerableQuestionStatus = Exclude<
  WatcherQuestionState['status'],
  'pending' | 'unverifiable'
>

export function orchestrationRequestIdForAttemptFingerprint(attemptFingerprint: string): string {
  if (!attemptFingerprint.trim()) {
    throw new Error('attemptFingerprint must be non-empty')
  }
  return createHash('sha256')
    .update('heimdall-dispatch-v1\0')
    .update(attemptFingerprint)
    .digest('hex')
}

export type HeimdallOrchestrationAdapter = {
  ensureRun(enrollment: WatcherEnrollment): Promise<{ runId: string }>
  dispatchWorker(input: DispatchWorkerInput): Promise<DispatchResult>
  recoverDispatch(input: DispatchWorkerInput): Promise<RecoverDispatchResult>
  readDispatch(enrollment: WatcherEnrollment, dispatchId: string): Promise<DispatchObservation>
  readAuthoritativeWorkerReport(
    enrollment: WatcherEnrollment,
    dispatchId: string
  ): Promise<EvidenceEntry | null>
  listWorkers(enrollment: WatcherEnrollment): Promise<WatcherWorker[]>
  stopWorker(enrollment: WatcherEnrollment, dispatchId: string): Promise<WatcherCommandResult>
  releaseWorker(enrollment: WatcherEnrollment, dispatchId: string): Promise<WorkerReleaseReceipt>
  drainMailbox(input: MailboxDrainInput): Promise<LedgerEntry[]>
  answerQuestion(enrollment: WatcherEnrollment, messageId: string, body: string): Promise<void>
  readQuestion(enrollment: WatcherEnrollment, messageId: string): Promise<WatcherQuestionState>
  observeWorkerIdle(
    enrollment: WatcherEnrollment,
    dispatchId: string
  ): Promise<WorkerIdleObservation>
  /** Types `text` into the worker's own agent prompt; throws {@link WorkerPromptUndeliverableError}. */
  sendWorkerPrompt(enrollment: WatcherEnrollment, dispatchId: string, text: string): Promise<void>
}

export class CoordinatorSeatLostError extends Error {
  readonly code = 'coordinator-seat-lost'
  readonly reason = { kind: 'coordinator-seat-lost' } as const

  constructor(watcherId: string, cause?: unknown) {
    const detail = cause instanceof Error ? `: ${cause.message}` : ''
    super(`Coordinator seat for Heimdall watcher ${watcherId} was lost${detail}`)
    this.name = 'CoordinatorSeatLostError'
  }
}

export class QuestionAlreadyAnsweredError extends Error {
  readonly code = 'question-already-answered'
  readonly reason = { kind: 'question-already-answered' } as const

  constructor(messageId: string, cause?: unknown) {
    const detail = cause instanceof Error ? `: ${cause.message}` : ''
    super(`Question ${messageId} was already answered${detail}`)
    this.name = 'QuestionAlreadyAnsweredError'
  }
}

/** The worker cannot safely receive a typed prompt: its process changed, or it is not a local PTY. */
export class WorkerPromptUndeliverableError extends Error {
  readonly code = 'worker-prompt-undeliverable'

  constructor(dispatchId: string, reason: string) {
    super(`Worker ${dispatchId} cannot receive a prompt: ${reason}`)
    this.name = 'WorkerPromptUndeliverableError'
  }
}
