import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { WatcherEnrollment } from '../../../shared/fork-heimdall/watcher-types'
import { OrchestrationError } from '../../runtime/orchestration/orchestration-error'
import { hashCanonical } from '../../runtime/rpc/orchestration-mutation-receipt'
import {
  CoordinatorSeatLostError,
  RuntimeHeimdallOrchestrationAdapter,
  orchestrationRequestIdForAttemptFingerprint
} from './orchestration-adapter'

const upstream = vi.hoisted(() => ({
  startLocalWorker: vi.fn(),
  resolveRunScope: vi.fn(),
  mutationRun: vi.fn(),
  inspectWorkerTerminal: vi.fn(),
  assertPromptBudget: vi.fn(),
  decideWorkerStartMode: vi.fn(() => ({
    mode: 'terminal',
    preferred: 'terminal',
    reason: 'user_default',
    detail: 'test mode'
  })),
  readWorkerStartModeSettings: vi.fn(() => null)
}))

vi.mock('../../runtime/rpc/methods/orchestration/worker/local-worker-start', () => ({
  startLocalWorker: upstream.startLocalWorker
}))
vi.mock('../../runtime/rpc/methods/orchestration/worker/worker-observation', () => ({
  inspectWorkerTerminal: upstream.inspectWorkerTerminal
}))
vi.mock('../../runtime/rpc/methods/orchestration/runs/run-scope', () => ({
  resolveRunScope: upstream.resolveRunScope
}))
vi.mock('../../runtime/rpc/orchestration-mutation-executor', () => ({
  getOrchestrationMutationExecutor: () => ({ run: upstream.mutationRun })
}))
vi.mock('../../runtime/rpc/methods/orchestration/worker/worker-start-prompt-budget', () => ({
  assertWorkerStartTaskSpecWithinPromptBudget: upstream.assertPromptBudget
}))
vi.mock('../../runtime/rpc/methods/orchestration-worker-start-mode', () => ({
  decideWorkerStartMode: upstream.decideWorkerStartMode,
  readWorkerStartModeSettings: upstream.readWorkerStartModeSettings
}))

const IDENTITY = {
  handle: 'heimdall-coordinator-persisted',
  paneKey: 'heimdall-pane-persisted'
}

function enrollment(overrides: Record<string, unknown> = {}): WatcherEnrollment {
  return {
    watcherId: 'watcher-1',
    kind: 'hosted-review',
    workspaceKey: 'local::/repo',
    executionHostId: 'local',
    repoId: 'repo-1',
    worktreeId: 'repo-1::/repo',
    workspacePath: '/repo',
    schedulerOwner: 'local_host_service',
    enabled: true,
    capabilities: {},
    budget: { wallClockActiveMs: null, turns: null },
    kindPayload: {},
    coordinatorIdentity: IDENTITY,
    orchestrationRunId: null,
    createdAtMs: 1,
    terminalAtMs: null,
    ...overrides
  } as unknown as WatcherEnrollment
}

type FakeRun = {
  id: string
  consumer_generation: number
  coordinator_handle: string
  coordinator_pane_key: string
}

type FakeDatabase = {
  createRun: Mock
  getCurrentRunForPane: Mock
  getRun: Mock
  getDispatchContextById: Mock
  getWorkerDispatch: Mock
  getMutationReceipt: Mock
  getMessageById: Mock
  getQuestion: Mock
  answerQuestion: Mock
}

function fakeDb(id: string): FakeDatabase {
  let run: FakeRun | undefined
  return {
    createRun: vi.fn(
      (params: { coordinatorHandle: string; coordinatorPaneKey: string }) =>
        (run = {
          id,
          consumer_generation: 1,
          coordinator_handle: params.coordinatorHandle,
          coordinator_pane_key: params.coordinatorPaneKey
        })
    ),
    getCurrentRunForPane: vi.fn(() => run),
    getRun: vi.fn((runId: string) => (runId === run?.id ? run : undefined)),
    getDispatchContextById: vi.fn(),
    getWorkerDispatch: vi.fn(),
    getMutationReceipt: vi.fn(),
    getMessageById: vi.fn(),
    getQuestion: vi.fn(),
    answerQuestion: vi.fn()
  }
}

function fakeRuntime(firstDb = fakeDb('run-1')) {
  let db = firstDb
  const realShowTerminal = vi.fn(async (handle: string) => ({ handle, worktreeId: 'unrelated' }))
  const runtime = {
    mutationCount: 0,
    getOrchestrationDb: vi.fn(() => db),
    showTerminal: realShowTerminal,
    getTerminalPaneKey: vi.fn(() => null),
    getClientSettings: vi.fn(() => null),
    ensureStructuredAgentSessionHost: vi.fn(async () => undefined),
    inspectTerminalProcessIncarnationLiveness: vi.fn(
      async (): Promise<'live' | 'exited' | 'unverifiable'> => 'unverifiable'
    ),
    recordRuntimeMutation() {
      this.mutationCount += 1
    }
  }
  return {
    runtime,
    realShowTerminal,
    replaceDb(next: FakeDatabase) {
      db = next
    }
  }
}

function invokeMutation() {
  upstream.mutationRun.mockImplementation(
    async (
      _request: unknown,
      _params: unknown,
      invoke: (mutation: {
        identity: {
          callerFingerprint: string
          requestId: string
          method: string
          payloadHash: string
        }
      }) => Promise<unknown>
    ) =>
      invoke({
        identity: {
          callerFingerprint: 'caller-fingerprint',
          requestId: 'request-id',
          method: 'orchestration.workerStart',
          payloadHash: 'payload-hash'
        }
      })
  )
}

describe('Heimdall orchestration adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invokeMutation()
    upstream.startLocalWorker.mockResolvedValue({ state: 'ready', dispatchId: 'dispatch-1' })
    upstream.resolveRunScope.mockReturnValue({
      id: 'run-1',
      consumer_generation: 1,
      coordinator_handle: IDENTITY.handle,
      coordinator_pane_key: IDENTITY.paneKey
    })
    upstream.inspectWorkerTerminal.mockResolvedValue({
      terminal: null,
      exact: true,
      status: 'live'
    })
  })

  it('creates one run, persists it, and reuses the pane-bound run on a second call', async () => {
    const { runtime } = fakeRuntime()
    const persist = vi.fn(async () => undefined)
    const adapter = new RuntimeHeimdallOrchestrationAdapter(runtime as never, {
      persistOrchestrationRunId: persist
    })
    const watched = enrollment()

    await expect(adapter.ensureRun(watched)).resolves.toEqual({ runId: 'run-1' })
    await expect(adapter.ensureRun(watched)).resolves.toEqual({ runId: 'run-1' })

    const db = runtime.getOrchestrationDb()
    expect(db.createRun).toHaveBeenCalledOnce()
    expect(db.createRun).toHaveBeenCalledWith({
      objective: 'Supervise Heimdall watcher watcher-1',
      coordinatorHandle: IDENTITY.handle,
      coordinatorPaneKey: IDENTITY.paneKey
    })
    expect(persist).toHaveBeenCalledTimes(2)
  })

  it('fetches the current orchestration database for every call', async () => {
    const first = fakeDb('run-1')
    const second = fakeDb('run-2')
    const world = fakeRuntime(first)
    const adapter = new RuntimeHeimdallOrchestrationAdapter(world.runtime as never, {
      persistOrchestrationRunId: async () => undefined
    })

    await adapter.ensureRun(enrollment())
    world.replaceDb(second)
    await adapter.ensureRun(
      enrollment({
        watcherId: 'watcher-2',
        coordinatorIdentity: {
          handle: 'heimdall-coordinator-2',
          paneKey: 'heimdall-pane-2'
        }
      })
    )

    expect(first.createRun).toHaveBeenCalledOnce()
    expect(second.createRun).toHaveBeenCalledOnce()
    expect(world.runtime.getOrchestrationDb).toHaveBeenCalledTimes(2)
  })

  it('uses the stable attempt-derived mutation request and the exact enrolled workspace', async () => {
    const world = fakeRuntime()
    const adapter = new RuntimeHeimdallOrchestrationAdapter(world.runtime as never, {
      persistOrchestrationRunId: async () => undefined
    })
    const watched = enrollment({ orchestrationRunId: 'run-1' })

    await expect(
      adapter.dispatchWorker({
        enrollment: watched,
        spec: 'Commit locally; do not publish.',
        agent: 'codex',
        taskKey: 'prepare-fix',
        attemptFingerprint: 'content:prepare-fix:evidence'
      })
    ).resolves.toEqual({ status: 'dispatched', dispatchId: 'dispatch-1' })

    const [request, params] = upstream.mutationRun.mock.calls[0]!
    expect(request).toMatchObject({
      method: 'orchestration.workerStart',
      orchestrationRequestId: orchestrationRequestIdForAttemptFingerprint(
        'content:prepare-fix:evidence'
      )
    })
    expect(params).toMatchObject({
      from: IDENTITY.handle,
      worktree: 'id:repo-1::/repo',
      spec: 'Commit locally; do not publish.',
      agent: 'codex',
      taskTitle: 'prepare-fix'
    })

    const workerArgs = upstream.startLocalWorker.mock.calls[0]![0]
    await expect(workerArgs.runtime.showTerminal(IDENTITY.handle)).resolves.toMatchObject({
      worktreeId: 'repo-1::/repo'
    })
    await expect(workerArgs.runtime.showTerminal('real-terminal')).resolves.toMatchObject({
      worktreeId: 'unrelated'
    })
    expect(workerArgs.runtime.getTerminalPaneKey(IDENTITY.handle)).toBe(IDENTITY.paneKey)
    expect(workerArgs.runtime.getTerminalPaneKey('real-terminal')).toBeNull()
    workerArgs.runtime.recordRuntimeMutation()
    expect(world.runtime.mutationCount).toBe(1)
    expect(workerArgs.coordinatorPane).toBe(IDENTITY.paneKey)
  })

  it('routes a folder enrollment only to its authoritative folder workspace id', async () => {
    const world = fakeRuntime()
    const adapter = new RuntimeHeimdallOrchestrationAdapter(world.runtime as never, {
      persistOrchestrationRunId: async () => undefined
    })

    await adapter.dispatchWorker({
      enrollment: enrollment({
        repoId: 'folder-1',
        worktreeId: null,
        orchestrationRunId: 'run-1'
      }),
      spec: 'work in this folder',
      attemptFingerprint: 'folder-attempt'
    })

    expect(upstream.mutationRun.mock.calls[0]![1]).toMatchObject({
      worktree: 'id:folder:folder-1'
    })
    const workerArgs = upstream.startLocalWorker.mock.calls[0]![0]
    await expect(workerArgs.runtime.showTerminal(IDENTITY.handle)).resolves.toMatchObject({
      worktreeId: 'folder:folder-1'
    })
  })

  it('answers through the currently fenced consumer generation', async () => {
    const world = fakeRuntime()
    const db = world.runtime.getOrchestrationDb()
    db.getQuestion.mockReturnValue({ message_id: 'message-question', run_id: 'run-1' })
    const adapter = new RuntimeHeimdallOrchestrationAdapter(world.runtime as never, {
      persistOrchestrationRunId: async () => undefined
    })

    await adapter.answerQuestion(
      enrollment({ orchestrationRunId: 'run-1' }),
      'message-question',
      'Use the prepared commit.'
    )

    expect(db.answerQuestion).toHaveBeenCalledWith({
      messageId: 'message-question',
      runId: 'run-1',
      consumerGeneration: 1,
      body: 'Use the prepared commit.'
    })
  })

  it.each(['consumer_fenced', 'run_not_found'] as const)(
    'parks a persisted identity when %s means its seat no longer resolves',
    async (code) => {
      const world = fakeRuntime()
      upstream.resolveRunScope.mockImplementation(() => {
        throw new OrchestrationError(code, 'seat missing')
      })
      const adapter = new RuntimeHeimdallOrchestrationAdapter(world.runtime as never, {
        persistOrchestrationRunId: async () => undefined
      })

      await expect(
        adapter.ensureRun(enrollment({ orchestrationRunId: 'run-lost' }))
      ).rejects.toBeInstanceOf(CoordinatorSeatLostError)
      expect(world.runtime.getOrchestrationDb().createRun).not.toHaveBeenCalled()
    }
  )

  it('returns indeterminate without retrying a pending receipt or a transport failure', async () => {
    const world = fakeRuntime()
    const adapter = new RuntimeHeimdallOrchestrationAdapter(world.runtime as never, {
      persistOrchestrationRunId: async () => undefined
    })
    const input = {
      enrollment: enrollment({ orchestrationRunId: 'run-1' }),
      spec: 'work',
      attemptFingerprint: 'stable-attempt'
    }
    upstream.mutationRun.mockRejectedValueOnce(
      new OrchestrationError('operation_unknown', 'pending receipt')
    )
    await expect(adapter.dispatchWorker(input)).resolves.toEqual({
      status: 'indeterminate',
      requestId: orchestrationRequestIdForAttemptFingerprint('stable-attempt')
    })
    expect(upstream.mutationRun).toHaveBeenCalledOnce()

    upstream.mutationRun.mockRejectedValueOnce(new Error('socket closed'))
    await expect(adapter.dispatchWorker(input)).resolves.toEqual({
      status: 'indeterminate',
      requestId: orchestrationRequestIdForAttemptFingerprint('stable-attempt')
    })
    expect(upstream.mutationRun).toHaveBeenCalledTimes(2)
  })

  it('recovers only an existing receipt and reports a missing receipt without creating it', async () => {
    const db = fakeDb('run-1')
    const world = fakeRuntime(db)
    const adapter = new RuntimeHeimdallOrchestrationAdapter(world.runtime as never, {
      persistOrchestrationRunId: async () => undefined
    })
    const input = {
      enrollment: enrollment({ orchestrationRunId: 'run-1' }),
      spec: 'work',
      attemptFingerprint: 'attempt-recovery'
    }
    const requestId = orchestrationRequestIdForAttemptFingerprint('attempt-recovery')
    const payloadHash = hashCanonical({
      method: 'orchestration.workerStart',
      params: {
        spec: 'work',
        from: IDENTITY.handle,
        worktree: 'id:repo-1::/repo'
      }
    })

    await expect(adapter.recoverDispatch({ ...input, enrollment: enrollment() })).resolves.toEqual({
      status: 'absent'
    })
    await expect(adapter.recoverDispatch(input)).resolves.toEqual({ status: 'absent' })

    db.getMutationReceipt.mockReturnValue({
      method: 'orchestration.workerStart',
      payload_hash: payloadHash,
      state: 'pending',
      receipt: null
    })
    await expect(adapter.recoverDispatch(input)).resolves.toEqual({
      status: 'indeterminate',
      requestId
    })

    db.getMutationReceipt.mockReturnValue({
      method: 'orchestration.workerStart',
      payload_hash: payloadHash,
      state: 'completed',
      receipt: JSON.stringify({ state: 'ready', dispatchId: 'dispatch-recovered' })
    })
    await expect(adapter.recoverDispatch(input)).resolves.toEqual({
      status: 'dispatched',
      dispatchId: 'dispatch-recovered'
    })

    expect(db.createRun).not.toHaveBeenCalled()
    expect(upstream.mutationRun).not.toHaveBeenCalled()
    expect(upstream.startLocalWorker).not.toHaveBeenCalled()
  })

  it('maps a superseded coordinator generation to a fenced refusal', async () => {
    const world = fakeRuntime()
    const adapter = new RuntimeHeimdallOrchestrationAdapter(world.runtime as never, {
      persistOrchestrationRunId: async () => undefined
    })
    upstream.resolveRunScope.mockImplementation(() => {
      throw new OrchestrationError('consumer_fenced', 'seat replaced')
    })

    await expect(
      adapter.dispatchWorker({
        enrollment: enrollment({ orchestrationRunId: 'run-1' }),
        spec: 'work',
        attemptFingerprint: 'attempt'
      })
    ).resolves.toEqual({
      status: 'refused',
      reason: 'fenced',
      detail: expect.stringContaining('seat replaced')
    })
    expect(upstream.mutationRun).not.toHaveBeenCalled()
  })

  it('uses authoritative execution-host evidence and never calls a disconnect exited', async () => {
    const world = fakeRuntime()
    const db = world.runtime.getOrchestrationDb()
    db.getDispatchContextById.mockReturnValue({
      id: 'dispatch-1',
      run_id: 'run-1',
      assignee_handle: 'term-worker',
      process_incarnation: 'remote:ssh-1:pty-1:incarnation-1',
      host_scope: JSON.stringify({ kind: 'ssh', targetId: 'ssh-1' })
    })
    upstream.inspectWorkerTerminal.mockResolvedValue({
      terminal: null,
      exact: false,
      status: 'missing'
    })
    world.runtime.inspectTerminalProcessIncarnationLiveness.mockRejectedValueOnce(
      new Error('SSH transport disconnected')
    )
    const adapter = new RuntimeHeimdallOrchestrationAdapter(world.runtime as never, {
      persistOrchestrationRunId: async () => undefined
    })

    await expect(
      adapter.readDispatch(enrollment({ orchestrationRunId: 'run-1' }), 'dispatch-1')
    ).resolves.toEqual({ status: 'unverifiable', reason: 'SSH transport disconnected' })

    world.runtime.inspectTerminalProcessIncarnationLiveness.mockResolvedValueOnce('exited')
    await expect(
      adapter.readDispatch(enrollment({ orchestrationRunId: 'run-1' }), 'dispatch-1')
    ).resolves.toEqual({ status: 'exited' })
  })

  it('installs and observes the structured worker host before classifying its dispatch', async () => {
    const world = fakeRuntime()
    const db = world.runtime.getOrchestrationDb()
    db.getDispatchContextById.mockReturnValue({
      id: 'dispatch-structured',
      run_id: 'run-1',
      assignee_handle: 'structworker_session-1',
      process_incarnation: 'structured:session-1',
      host_scope: JSON.stringify({ kind: 'local', hostId: 'local' })
    })
    upstream.inspectWorkerTerminal.mockResolvedValue({
      terminal: null,
      exact: true,
      status: 'live'
    })
    const adapter = new RuntimeHeimdallOrchestrationAdapter(world.runtime as never, {
      persistOrchestrationRunId: async () => undefined
    })

    await expect(
      adapter.readDispatch(enrollment({ orchestrationRunId: 'run-1' }), 'dispatch-structured')
    ).resolves.toEqual({ status: 'live' })
    expect(world.runtime.ensureStructuredAgentSessionHost).toHaveBeenCalledOnce()
  })
})
