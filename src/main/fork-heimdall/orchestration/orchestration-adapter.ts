import type { RuntimeTerminalShow } from '../../../shared/runtime-types'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { RunRow } from '../../runtime/orchestration/db'
import { OrchestrationError } from '../../runtime/orchestration/orchestration-error'
import { resolveRunScope } from '../../runtime/rpc/methods/orchestration/runs/run-scope'
import { startLocalWorker } from '../../runtime/rpc/methods/orchestration/worker/local-worker-start'
import { inspectWorkerTerminal } from '../../runtime/rpc/methods/orchestration/worker/worker-observation'
import { assertWorkerStartTaskSpecWithinPromptBudget } from '../../runtime/rpc/methods/orchestration/worker/worker-start-prompt-budget'
import {
  decideWorkerStartMode,
  readWorkerStartModeSettings
} from '../../runtime/rpc/methods/orchestration-worker-start-mode'
import { getOrchestrationMutationExecutor } from '../../runtime/rpc/orchestration-mutation-executor'
import {
  hashCanonical,
  replayStableCallerParams
} from '../../runtime/rpc/orchestration-mutation-receipt'
import type { RpcRequest } from '../../runtime/rpc/core'
import type {
  DispatchResult,
  DispatchWorkerInput
} from '../../../shared/fork-heimdall/kind-contract'
import type { WatcherCommandResult, WatcherWorker } from '../../../shared/fork-heimdall/fleet-types'
import type { LedgerEntry } from '../../../shared/fork-heimdall/ledger-types'
import type { WatcherEnrollment } from '../../../shared/fork-heimdall/watcher-types'
import { resolveWorkerStartReadinessTimeoutMs } from '../../../shared/orchestration-timing-budgets'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/protocol-version'
import { isStructuredWorkerHandle } from '../../runtime/structured-worker-identity'
import { coordinatorIdentityFingerprint } from './coordinator-identity'
import {
  CoordinatorSeatLostError,
  orchestrationRequestIdForAttemptFingerprint,
  QuestionAlreadyAnsweredError,
  type DispatchObservation,
  type HeimdallOrchestrationAdapter,
  type HeimdallOrchestrationPersistence,
  type RecoverDispatchResult
} from './orchestration-contract'
import { drainHeimdallMailbox, type MailboxDrainInput } from './mailbox-drain'
import { answerWatcherQuestion } from './question-answer'
import { listWatcherWorkers, stopWatcherWorker } from './worker-controls'

export {
  CoordinatorSeatLostError,
  orchestrationRequestIdForAttemptFingerprint,
  QuestionAlreadyAnsweredError
}
export type { DispatchResult, DispatchWorkerInput }
export type {
  DispatchObservation,
  HeimdallOrchestrationAdapter,
  HeimdallOrchestrationPersistence,
  RecoverDispatchResult
}
export type { CoordinatorIdentity } from '../../../shared/fork-heimdall/watcher-types'
export type { MailboxCursor, MailboxDrainInput } from './mailbox-drain'

type WorkerStartReceipt = {
  dispatchId?: string
  state?: string
  lastError?: string
}

const CAPABILITY_ERROR_CODES: Record<string, true> = {
  capability_invalid: true,
  capability_unsupported: true,
  invalid_argument: true,
  request_mismatch: true,
  task_not_startable: true,
  worker_prompt_too_large: true
}
const PLACEMENT_ERROR_CODES: Record<string, true> = {
  folder_worktree_unsupported: true,
  repo_not_found: true,
  selector_ambiguous: true,
  selector_not_found: true,
  terminal_worktree_mismatch: true,
  worktree_not_found: true,
  worktree_not_found_on_server: true
}

export class RuntimeHeimdallOrchestrationAdapter implements HeimdallOrchestrationAdapter {
  constructor(
    private readonly runtime: OrcaRuntimeService,
    private readonly persistence: HeimdallOrchestrationPersistence
  ) {}

  async ensureRun(enrollment: WatcherEnrollment): Promise<{ runId: string }> {
    const identity = enrollment.coordinatorIdentity
    if (enrollment.orchestrationRunId) {
      const run = this.resolvePersistedRun(enrollment, enrollment.orchestrationRunId)
      this.assertRunIdentity(enrollment, run)
      return { runId: run.id }
    }

    const db = this.runtime.getOrchestrationDb()
    const current = db.getCurrentRunForPane(identity.paneKey)
    const run =
      current ??
      db.createRun({
        objective: `Supervise Heimdall watcher ${enrollment.watcherId}`,
        coordinatorHandle: identity.handle,
        coordinatorPaneKey: identity.paneKey
      })
    this.assertRunIdentity(enrollment, run)
    await this.persistence.persistOrchestrationRunId(enrollment.watcherId, run.id)
    return { runId: run.id }
  }

  async dispatchWorker(input: DispatchWorkerInput): Promise<DispatchResult> {
    const requestId = orchestrationRequestIdForAttemptFingerprint(input.attemptFingerprint)
    let run: RunRow
    try {
      const ensured = await this.ensureRun(input.enrollment)
      run = this.resolvePersistedRun(input.enrollment, ensured.runId)
      this.assertRunIdentity(input.enrollment, run)
    } catch (error) {
      if (
        error instanceof CoordinatorSeatLostError ||
        isOrchestrationError(error, 'consumer_fenced')
      ) {
        return refused('fenced', error)
      }
      return { status: 'indeterminate', requestId }
    }

    const db = this.runtime.getOrchestrationDb()
    const identity = input.enrollment.coordinatorIdentity
    const params = workerStartParams(input)

    try {
      await assertWorkerStartTaskSpecWithinPromptBudget(input.spec)
      const mode = decideWorkerStartMode({
        params,
        settings: readWorkerStartModeSettings(this.runtime)
      })
      const request: RpcRequest = {
        id: `heimdall-${requestId}`,
        authToken: '',
        method: 'orchestration.workerStart',
        params,
        orchestrationRequestId: requestId,
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION
      }
      const receipt = (await getOrchestrationMutationExecutor(this.runtime).run(
        request,
        params,
        (mutation) =>
          startLocalWorker({
            params: {
              ...params,
              timeoutMs: resolveWorkerStartReadinessTimeoutMs(undefined)
            },
            runtime: coordinatorRuntimeFacade(this.runtime, input.enrollment),
            db,
            run,
            coordinatorPane: identity.paneKey,
            orchestrationMutation: mutation?.identity,
            mode
          }),
        coordinatorIdentityFingerprint(identity)
      )) as WorkerStartReceipt
      return dispatchResultFromReceipt(receipt, requestId)
    } catch (error) {
      if (isOrchestrationError(error, 'consumer_fenced')) {
        return refused('fenced', error)
      }
      if (error instanceof OrchestrationError && CAPABILITY_ERROR_CODES[error.code]) {
        return refused('capability-invalid', error)
      }
      if (error instanceof OrchestrationError && PLACEMENT_ERROR_CODES[error.code]) {
        return refused('placement-unavailable', error)
      }
      return { status: 'indeterminate', requestId }
    }
  }

  async recoverDispatch(input: DispatchWorkerInput): Promise<RecoverDispatchResult> {
    const requestId = orchestrationRequestIdForAttemptFingerprint(input.attemptFingerprint)
    if (!input.enrollment.orchestrationRunId) {
      return { status: 'absent' }
    }
    const run = this.resolvePersistedRun(input.enrollment, input.enrollment.orchestrationRunId)
    this.assertRunIdentity(input.enrollment, run)
    const db = this.runtime.getOrchestrationDb()
    const params = workerStartParams(input)
    const callerFingerprint = coordinatorIdentityFingerprint(input.enrollment.coordinatorIdentity)
    const receipt = db.getMutationReceipt(callerFingerprint, requestId)
    if (!receipt) {
      return { status: 'absent' }
    }
    const payloadHash = hashCanonical({
      method: 'orchestration.workerStart',
      params: replayStableCallerParams(this.runtime, params)
    })
    if (receipt.method !== 'orchestration.workerStart' || receipt.payload_hash !== payloadHash) {
      return {
        status: 'refused',
        reason: 'capability-invalid',
        detail: `Mutation request ${requestId} was already used with different input.`
      }
    }
    if (receipt.state === 'pending') {
      return { status: 'indeterminate', requestId }
    }
    const completed = parseWorkerStartReceipt(receipt.receipt)
    return completed
      ? dispatchResultFromReceipt(completed, requestId)
      : { status: 'indeterminate', requestId }
  }

  async readDispatch(
    enrollment: WatcherEnrollment,
    dispatchId: string
  ): Promise<DispatchObservation> {
    if (!dispatchId.trim()) {
      throw new Error('dispatchId must be non-empty')
    }
    const ensured = await this.ensureRun(enrollment)
    const db = this.runtime.getOrchestrationDb()
    const run = this.resolvePersistedRun(enrollment, ensured.runId)
    this.assertRunIdentity(enrollment, run)
    const dispatch = db.getDispatchContextById(dispatchId)
    if (!dispatch) {
      return { status: 'unverifiable', reason: `Dispatch ${dispatchId} was not found` }
    }
    if (dispatch.run_id !== run.id) {
      return {
        status: 'unverifiable',
        reason: `Dispatch ${dispatchId} does not belong to Run ${run.id}`
      }
    }

    const handle =
      db.getWorkerDispatch(dispatchId)?.agent_terminal_handle ?? dispatch.assignee_handle
    if (isStructuredWorkerHandle(handle)) {
      try {
        await this.runtime.ensureStructuredAgentSessionHost()
      } catch (error) {
        return {
          status: 'unverifiable',
          reason: `Structured worker host unavailable: ${errorDetail(error)}`
        }
      }
    }

    let observation: Awaited<ReturnType<typeof inspectWorkerTerminal>>
    try {
      observation = await inspectWorkerTerminal(this.runtime, db, dispatchId)
    } catch (error) {
      return { status: 'unverifiable', reason: errorDetail(error) }
    }
    if (observation.status === 'live' || observation.status === 'exited') {
      return { status: observation.status }
    }
    if (observation.status === 'unverifiable') {
      return observation.reason
        ? { status: 'unverifiable', reason: observation.reason }
        : { status: 'unverifiable' }
    }
    if (!dispatch.process_incarnation) {
      return {
        status: 'unverifiable',
        reason: `Dispatch ${dispatchId} has no exact process incarnation`
      }
    }

    try {
      const status = await this.runtime.inspectTerminalProcessIncarnationLiveness(
        dispatch.process_incarnation,
        dispatch.host_scope
      )
      return status === 'unverifiable'
        ? {
            status,
            reason:
              observation.reason ??
              `Dispatch ${dispatchId} process liveness is unavailable from its execution host`
          }
        : { status }
    } catch (error) {
      return { status: 'unverifiable', reason: errorDetail(error) }
    }
  }
  async listWorkers(enrollment: WatcherEnrollment): Promise<WatcherWorker[]> {
    if (!enrollment.orchestrationRunId) {
      return []
    }
    const run = this.resolvePersistedRun(enrollment, enrollment.orchestrationRunId)
    this.assertRunIdentity(enrollment, run)
    return listWatcherWorkers(this.runtime, enrollment, run)
  }

  async stopWorker(
    enrollment: WatcherEnrollment,
    dispatchId: string
  ): Promise<WatcherCommandResult> {
    if (!dispatchId.trim()) {
      return {
        status: 'refused',
        reason: 'invalid-command',
        detail: 'dispatchId must be non-empty'
      }
    }
    if (!enrollment.orchestrationRunId) {
      return {
        status: 'refused',
        reason: 'worker-unverifiable',
        detail: `Watcher ${enrollment.watcherId} has no orchestration Run`
      }
    }
    const run = this.resolvePersistedRun(enrollment, enrollment.orchestrationRunId)
    this.assertRunIdentity(enrollment, run)
    return stopWatcherWorker(this.runtime, enrollment, run, dispatchId, () => {
      const current = this.resolvePersistedRun(enrollment, run.id)
      this.assertRunIdentity(enrollment, current)
    })
  }

  async drainMailbox(input: MailboxDrainInput): Promise<LedgerEntry[]> {
    const ensured = await this.ensureRun(input.enrollment)
    const run = this.resolvePersistedRun(input.enrollment, ensured.runId)
    this.assertRunIdentity(input.enrollment, run)
    try {
      return await drainHeimdallMailbox({
        runtime: this.runtime,
        enrollment: input.enrollment,
        run,
        cursor: input.cursor
      })
    } catch (error) {
      if (isOrchestrationError(error, 'consumer_fenced')) {
        throw new CoordinatorSeatLostError(input.enrollment.watcherId, error)
      }
      throw error
    }
  }

  async answerQuestion(
    enrollment: WatcherEnrollment,
    messageId: string,
    body: string
  ): Promise<void> {
    if (!messageId.trim() || !body.trim()) {
      throw new Error('messageId and body must be non-empty')
    }
    const ensured = await this.ensureRun(enrollment)
    const run = this.resolvePersistedRun(enrollment, ensured.runId)
    this.assertRunIdentity(enrollment, run)
    try {
      answerWatcherQuestion(this.runtime, run, messageId, body)
    } catch (error) {
      if (isOrchestrationError(error, 'consumer_fenced')) {
        throw new CoordinatorSeatLostError(enrollment.watcherId, error)
      }
      if (isOrchestrationError(error, 'answer_conflict')) {
        throw new QuestionAlreadyAnsweredError(messageId, error)
      }
      throw error
    }
  }

  private resolvePersistedRun(enrollment: WatcherEnrollment, runId: string): RunRow {
    try {
      return resolveRunScope(this.runtime, {
        runId,
        callerTerminalHandle: enrollment.coordinatorIdentity.handle,
        callerPaneKey: enrollment.coordinatorIdentity.paneKey,
        requireCurrentConsumer: true
      })
    } catch (error) {
      if (
        error instanceof OrchestrationError &&
        ['consumer_fenced', 'run_not_found', 'run_required'].includes(error.code)
      ) {
        throw new CoordinatorSeatLostError(enrollment.watcherId, error)
      }
      throw error
    }
  }

  private assertRunIdentity(enrollment: WatcherEnrollment, run: RunRow): void {
    const identity = enrollment.coordinatorIdentity
    if (
      run.coordinator_handle !== identity.handle ||
      run.coordinator_pane_key !== identity.paneKey
    ) {
      throw new CoordinatorSeatLostError(
        enrollment.watcherId,
        new Error('Persisted coordinator identity does not own the resolved Run')
      )
    }
  }
}

function workerStartParams(input: DispatchWorkerInput) {
  return {
    spec: input.spec,
    from: input.enrollment.coordinatorIdentity.handle,
    worktree: `id:${workspaceRuntimeId(input.enrollment)}`,
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.deps ? { deps: JSON.stringify(input.deps) } : {}),
    ...(input.taskKey ? { taskTitle: input.taskKey } : {})
  }
}

function parseWorkerStartReceipt(serialized: string | null): WorkerStartReceipt | null {
  if (!serialized) {
    return null
  }
  try {
    const value: unknown = JSON.parse(serialized)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null
    }
    const receipt = value as Record<string, unknown>
    if (typeof receipt.state !== 'string') {
      return null
    }
    if (receipt.dispatchId !== undefined && typeof receipt.dispatchId !== 'string') {
      return null
    }
    if (receipt.lastError !== undefined && typeof receipt.lastError !== 'string') {
      return null
    }
    return {
      state: receipt.state,
      ...(typeof receipt.dispatchId === 'string' ? { dispatchId: receipt.dispatchId } : {}),
      ...(typeof receipt.lastError === 'string' ? { lastError: receipt.lastError } : {})
    }
  } catch {
    return null
  }
}

export function workspaceRuntimeId(enrollment: WatcherEnrollment): string {
  return enrollment.worktreeId ?? `${enrollment.repoId}::${enrollment.workspacePath}`
}

function coordinatorRuntimeFacade(
  runtime: OrcaRuntimeService,
  enrollment: WatcherEnrollment
): OrcaRuntimeService {
  const identity = enrollment.coordinatorIdentity
  const workspaceId = workspaceRuntimeId(enrollment)
  const boundMethods = new Map<PropertyKey, { source: object; bound: object }>()
  const syntheticShow = async (handle: string) => {
    if (handle === identity.handle) {
      return { worktreeId: workspaceId } as RuntimeTerminalShow
    }
    return runtime.showTerminal(handle)
  }
  const syntheticPaneKey = (handle: string) =>
    handle === identity.handle ? identity.paneKey : runtime.getTerminalPaneKey(handle)

  // The two exact-handle overrides expose only the authority worker-start needs. Every other
  // method stays bound to the real runtime, so private fields and runtime state cannot land on
  // the facade.
  return new Proxy(runtime, {
    get(target, property) {
      if (property === 'showTerminal') {
        return syntheticShow
      }
      if (property === 'getTerminalPaneKey') {
        return syntheticPaneKey
      }
      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function') {
        return value
      }
      const cached = boundMethods.get(property)
      if (cached && cached.source === value) {
        return cached.bound
      }
      const bound = value.bind(target) as object
      boundMethods.set(property, { source: value, bound })
      return bound
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target)
    }
  })
}

function dispatchResultFromReceipt(receipt: WorkerStartReceipt, requestId: string): DispatchResult {
  if (receipt.state === 'ready' && receipt.dispatchId) {
    return { status: 'dispatched', dispatchId: receipt.dispatchId }
  }
  if (receipt.state === 'outcome_unknown' || receipt.state === 'start_unknown') {
    return { status: 'indeterminate', requestId }
  }
  return {
    status: 'refused',
    reason: 'placement-unavailable',
    detail: receipt.lastError ?? `Worker start returned state ${receipt.state ?? 'unknown'}`
  }
}

function refused(
  reason: Extract<DispatchResult, { status: 'refused' }>['reason'],
  error: unknown
): DispatchResult {
  return {
    status: 'refused',
    reason,
    detail: error instanceof Error ? error.message : String(error)
  }
}

function isOrchestrationError(error: unknown, code: string): error is OrchestrationError {
  return error instanceof OrchestrationError && error.code === code
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
