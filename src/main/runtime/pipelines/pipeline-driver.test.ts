import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FakeOrchestrationDb,
  FakePipelineRunDb,
  definitionOf,
  flushAsync,
  node,
  nodeRow,
  publisherStub,
  runRow,
  runtimeStub,
  workerStartResponse
} from './pipeline-driver-test-support'
import type { PipelineSnapshotPublisher } from './pipeline-snapshot-publisher'

const resolveContextMock = vi.fn()
const executeLocalWorkerStartMock = vi.fn()
const validatePipelineNodeLaunchMock = vi.fn()

vi.mock('./pipeline-driver-run-context', () => ({
  resolvePipelineDriverRunContext: (...args: unknown[]) => resolveContextMock(...args)
}))
vi.mock('../rpc/methods/orchestration-worker-start-execution', () => ({
  executeLocalWorkerStart: (...args: unknown[]) => executeLocalWorkerStartMock(...args)
}))
vi.mock('./pipeline-preflight', () => ({
  validatePipelineNodeLaunch: (...args: unknown[]) => validatePipelineNodeLaunchMock(...args)
}))

const { PipelineDriver } = await import('./pipeline-driver')

async function advanceOneCycle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1_000)
}

describe('PipelineDriver', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resolveContextMock.mockReset().mockResolvedValue({
      dispatchWorktreeId: 'worktree-1',
      isFolderMode: false,
      host: {}
    })
    validatePipelineNodeLaunchMock.mockReset().mockResolvedValue({ ok: true, agent: 'claude' })
    executeLocalWorkerStartMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('serializes dispatch in `nodes` list order and completes the run once every node succeeds', async () => {
    const nodeA = node({ id: 'a', index: 0 })
    const nodeB = node({ id: 'b', index: 1 })
    const db = new FakeOrchestrationDb()
    db.tasks.set('task-a', { id: 'task-a', status: 'ready', result: null })
    db.tasks.set('task-b', { id: 'task-b', status: 'ready', result: null })
    const pipelineDb = new FakePipelineRunDb(
      runRow(),
      new Map([
        ['a', nodeRow({ node_id: 'a', node_index: 0, task_id: 'task-a' })],
        ['b', nodeRow({ node_id: 'b', node_index: 1, task_id: 'task-b' })]
      ])
    )
    const publisher = publisherStub()
    const runtime = runtimeStub()

    executeLocalWorkerStartMock.mockImplementation(async (args: { taskId: string }) => {
      const task = db.tasks.get(args.taskId)
      if (task) {
        task.status = 'dispatched'
      }
      return workerStartResponse({
        taskId: args.taskId,
        dispatchId: `d-${args.taskId}`,
        state: 'ready'
      })
    })

    const driver = new PipelineDriver({
      runtime,
      db: db.asOrchestrationDb(),
      pipelineDb: pipelineDb.asPipelineRunDb(),
      runId: 'run-1',
      definition: definitionOf([nodeA, nodeB]),
      publisher: publisher as unknown as PipelineSnapshotPublisher
    })

    driver.start()
    await flushAsync()

    // both roots are ready simultaneously; only the list-order-first one dispatches
    expect(executeLocalWorkerStartMock).toHaveBeenCalledTimes(1)
    expect(executeLocalWorkerStartMock.mock.calls[0][0]).toMatchObject({ taskId: 'task-a' })

    db.tasks.set('task-a', { id: 'task-a', status: 'completed', result: 'result-a' })
    await advanceOneCycle() // tick: observe a's success

    expect(pipelineDb.setNodeOutcome).toHaveBeenCalledWith('run-1', 'a', { outcome: 'succeeded' })
    expect(pipelineDb.run.state).toBe('running')

    await advanceOneCycle() // tick: dispatch b
    expect(executeLocalWorkerStartMock).toHaveBeenCalledTimes(2)
    expect(executeLocalWorkerStartMock.mock.calls[1][0]).toMatchObject({ taskId: 'task-b' })

    db.tasks.set('task-b', { id: 'task-b', status: 'completed', result: 'result-b' })
    await advanceOneCycle() // tick: observe b's success -> run completes

    expect(pipelineDb.run.state).toBe('completed')
    driver.stop()
  })

  it('exhaustion: fails the node and the run, and never dispatches the not-yet-dispatched downstream node', async () => {
    const upstream = node({ id: 'up', index: 0 })
    const downstream = node({ id: 'down', index: 1, needs: ['up'] })
    const db = new FakeOrchestrationDb()
    db.tasks.set('task-up', { id: 'task-up', status: 'ready', result: null })
    db.tasks.set('task-down', { id: 'task-down', status: 'pending', result: null })
    const pipelineDb = new FakePipelineRunDb(
      runRow(),
      new Map([
        ['up', nodeRow({ node_id: 'up', node_index: 0, task_id: 'task-up' })],
        ['down', nodeRow({ node_id: 'down', node_index: 1, task_id: 'task-down' })]
      ])
    )
    const runtime = runtimeStub()

    executeLocalWorkerStartMock.mockImplementation(
      async (args: { taskId: string; retryOf?: string }) => {
        const dispatchId = `d-${args.taskId}-${db.dispatches.size}`
        db.registerDispatch({
          dispatchId,
          taskId: args.taskId,
          workerState: 'failed',
          spawnReceipt: { committed: true }
        })
        db.tasks.set(args.taskId, { id: args.taskId, status: 'failed', result: null })
        return workerStartResponse({ taskId: args.taskId, dispatchId, state: 'failed' })
      }
    )

    const driver = new PipelineDriver({
      runtime,
      db: db.asOrchestrationDb(),
      pipelineDb: pipelineDb.asPipelineRunDb(),
      runId: 'run-1',
      definition: definitionOf([upstream, downstream]),
      publisher: publisherStub() as unknown as PipelineSnapshotPublisher
    })

    driver.start()
    await flushAsync()

    expect(executeLocalWorkerStartMock).toHaveBeenCalledTimes(1)
    expect(pipelineDb.nodesById.get('up')?.outcome).toBe('failed')
    expect(pipelineDb.run.state).toBe('failed')
    // the downstream task must never have been dispatched
    expect(executeLocalWorkerStartMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-down' })
    )
    expect(pipelineDb.nodesById.get('down')?.outcome).toBeNull()
    driver.stop()
  })

  it('pause/resume: holds at the node boundary, does not dispatch the next node until resumed, and is idempotent', async () => {
    const nodeA = node({ id: 'a', index: 0 })
    const nodeB = node({ id: 'b', index: 1 })
    const db = new FakeOrchestrationDb()
    db.tasks.set('task-a', { id: 'task-a', status: 'ready', result: null })
    db.tasks.set('task-b', { id: 'task-b', status: 'ready', result: null })
    const pipelineDb = new FakePipelineRunDb(
      runRow(),
      new Map([
        ['a', nodeRow({ node_id: 'a', node_index: 0, task_id: 'task-a' })],
        ['b', nodeRow({ node_id: 'b', node_index: 1, task_id: 'task-b' })]
      ])
    )
    const publisher = publisherStub()
    const runtime = runtimeStub()
    executeLocalWorkerStartMock.mockImplementation(async (args: { taskId: string }) => {
      db.tasks.get(args.taskId)!.status = 'dispatched'
      return workerStartResponse({
        taskId: args.taskId,
        dispatchId: `d-${args.taskId}`,
        state: 'ready'
      })
    })

    const driver = new PipelineDriver({
      runtime,
      db: db.asOrchestrationDb(),
      pipelineDb: pipelineDb.asPipelineRunDb(),
      runId: 'run-1',
      definition: definitionOf([nodeA, nodeB]),
      publisher: publisher as unknown as PipelineSnapshotPublisher
    })

    driver.start()
    await flushAsync() // dispatches a

    driver.pause()
    driver.pause() // idempotent: must not double-write
    expect(pipelineDb.updateRunState).toHaveBeenCalledWith('run-1', 'paused')
    expect(pipelineDb.updateRunState).toHaveBeenCalledTimes(1)
    expect(publisher.setPausingAnnotation).toHaveBeenCalledWith('run-1', true)
    expect(pipelineDb.run.state).toBe('paused')

    db.tasks.set('task-a', { id: 'task-a', status: 'completed', result: 'result-a' })
    await advanceOneCycle() // a's in-flight attempt still runs to completion while paused
    expect(pipelineDb.nodesById.get('a')?.outcome).toBe('succeeded')

    await advanceOneCycle()
    await advanceOneCycle()
    // paused: b must never dispatch no matter how many cycles pass
    expect(executeLocalWorkerStartMock).toHaveBeenCalledTimes(1)

    driver.resume()
    driver.resume() // idempotent
    expect(publisher.setPausingAnnotation).toHaveBeenCalledWith('run-1', false)
    // completes the running -> paused -> running sequence (AC9)
    expect(pipelineDb.run.state).toBe('running')

    await advanceOneCycle() // dispatches b within one cycle of resume
    expect(executeLocalWorkerStartMock).toHaveBeenCalledTimes(2)
    expect(executeLocalWorkerStartMock.mock.calls[1][0]).toMatchObject({ taskId: 'task-b' })
    driver.stop()
  })

  it('abort: writes aborted immediately, sends \\x03 to the running node, and never dispatches again', async () => {
    const nodeA = node({ id: 'a', index: 0 })
    const nodeB = node({ id: 'b', index: 1 })
    const db = new FakeOrchestrationDb()
    db.tasks.set('task-a', { id: 'task-a', status: 'ready', result: null })
    db.tasks.set('task-b', { id: 'task-b', status: 'ready', result: null })
    const pipelineDb = new FakePipelineRunDb(
      runRow(),
      new Map([
        ['a', nodeRow({ node_id: 'a', node_index: 0, task_id: 'task-a' })],
        ['b', nodeRow({ node_id: 'b', node_index: 1, task_id: 'task-b' })]
      ])
    )
    const runtime = runtimeStub()
    executeLocalWorkerStartMock.mockImplementation(async (args: { taskId: string }) => {
      db.tasks.get(args.taskId)!.status = 'dispatched'
      return workerStartResponse({
        taskId: args.taskId,
        dispatchId: `d-${args.taskId}`,
        state: 'ready',
        effects: [{ kind: 'terminal', role: 'agent', action: 'created', id: 'term-a' }]
      })
    })

    const driver = new PipelineDriver({
      runtime,
      db: db.asOrchestrationDb(),
      pipelineDb: pipelineDb.asPipelineRunDb(),
      runId: 'run-1',
      definition: definitionOf([nodeA, nodeB]),
      publisher: publisherStub() as unknown as PipelineSnapshotPublisher
    })

    driver.start()
    await flushAsync() // dispatches a

    await driver.abort()
    expect(pipelineDb.updateRunState).toHaveBeenCalledWith('run-1', 'aborted')
    expect(runtime.sendTerminal).toHaveBeenCalledWith('term-a', { interrupt: true })

    await driver.abort() // idempotent: no second interrupt, no second state write
    expect(runtime.sendTerminal).toHaveBeenCalledTimes(1)
    expect(pipelineDb.updateRunState).toHaveBeenCalledTimes(1)

    db.tasks.set('task-a', { id: 'task-a', status: 'completed', result: 'result-a' })
    await advanceOneCycle()
    await advanceOneCycle()
    expect(executeLocalWorkerStartMock).toHaveBeenCalledTimes(1) // never dispatches b after abort
    driver.stop()
  })

  it('abort: a dispatch already in flight when abort runs must not install a live attempt, and any spawned agent still gets the interrupt', async () => {
    const nodeA = node({ id: 'a', index: 0 })
    const db = new FakeOrchestrationDb()
    db.tasks.set('task-a', { id: 'task-a', status: 'ready', result: null })
    const pipelineDb = new FakePipelineRunDb(
      runRow(),
      new Map([['a', nodeRow({ node_id: 'a', node_index: 0, task_id: 'task-a' })]])
    )
    const runtime = runtimeStub()

    let resolveWorkerStart: (value: ReturnType<typeof workerStartResponse>) => void = () => {
      throw new Error('resolveWorkerStart called before the mock ran')
    }
    executeLocalWorkerStartMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveWorkerStart = resolve
        })
    )

    const driver = new PipelineDriver({
      runtime,
      db: db.asOrchestrationDb(),
      pipelineDb: pipelineDb.asPipelineRunDb(),
      runId: 'run-1',
      definition: definitionOf([nodeA]),
      publisher: publisherStub() as unknown as PipelineSnapshotPublisher
    })

    driver.start()
    await flushAsync() // dispatch is now awaiting worker-start; nothing has recorded itself yet

    await driver.abort()
    expect(pipelineDb.updateRunState).toHaveBeenCalledWith('run-1', 'aborted')
    expect(runtime.sendTerminal).not.toHaveBeenCalled() // abort had no recorded in-flight attempt to interrupt

    resolveWorkerStart(
      workerStartResponse({
        taskId: 'task-a',
        dispatchId: 'd-a',
        state: 'ready',
        effects: [{ kind: 'terminal', role: 'agent', action: 'created', id: 'term-a' }]
      })
    )
    await flushAsync()

    // the race-losing dispatch spawned an agent after abort: it must still receive the interrupt...
    expect(runtime.sendTerminal).toHaveBeenCalledWith('term-a', { interrupt: true })
    // ...and must never have become a live in-flight attempt
    expect(pipelineDb.beginAttempt).not.toHaveBeenCalled()

    await advanceOneCycle()
    await advanceOneCycle()
    expect(executeLocalWorkerStartMock).toHaveBeenCalledTimes(1) // no further dispatch after abort
    driver.stop()
  })

  it('abort: reaches an attempt whose process has already spawned but whose worker-start call has not returned yet (the readiness-wait window)', async () => {
    const nodeA = node({ id: 'a', index: 0 })
    const db = new FakeOrchestrationDb()
    db.tasks.set('task-a', { id: 'task-a', status: 'ready', result: null })
    const pipelineDb = new FakePipelineRunDb(
      runRow(),
      new Map([['a', nodeRow({ node_id: 'a', node_index: 0, task_id: 'task-a' })]])
    )
    const runtime = runtimeStub()

    let resolveWorkerStart: (value: ReturnType<typeof workerStartResponse>) => void = () => {
      throw new Error('resolveWorkerStart called before the mock ran')
    }
    executeLocalWorkerStartMock.mockImplementation(
      (args: { taskId: string; onPtySpawnCommitted?: () => void }) =>
        new Promise((resolve) => {
          resolveWorkerStart = resolve
          // simulate the PTY spawn committing (and the terminal handle landing in the durable
          // dispatch record, as `persistWorkerReadinessStage` does) while the readiness wait
          // that follows is still pending — this is the up-to-60s window the finding is about
          db.registerDispatch({
            dispatchId: 'd-a',
            taskId: args.taskId,
            workerState: 'starting',
            agentTerminalHandle: 'term-a'
          })
          args.onPtySpawnCommitted?.()
        })
    )

    const driver = new PipelineDriver({
      runtime,
      db: db.asOrchestrationDb(),
      pipelineDb: pipelineDb.asPipelineRunDb(),
      runId: 'run-1',
      definition: definitionOf([nodeA]),
      publisher: publisherStub() as unknown as PipelineSnapshotPublisher
    })

    driver.start()
    await flushAsync() // spawn has committed; worker-start is still awaiting the readiness wait

    await driver.abort()
    expect(pipelineDb.updateRunState).toHaveBeenCalledWith('run-1', 'aborted')
    // reachable before the readiness wait resolves, not only once the whole call returns
    expect(runtime.sendTerminal).toHaveBeenCalledWith('term-a', { interrupt: true })

    resolveWorkerStart(
      workerStartResponse({
        taskId: 'task-a',
        dispatchId: 'd-a',
        state: 'ready',
        effects: [{ kind: 'terminal', role: 'agent', action: 'created', id: 'term-a' }]
      })
    )
    await flushAsync()
    expect(pipelineDb.beginAttempt).not.toHaveBeenCalled() // still never becomes a live attempt

    driver.stop()
  })

  it('abort: a dispatch still awaiting preflight when abort runs must never reach the launch at all', async () => {
    const nodeA = node({ id: 'a', index: 0 })
    const db = new FakeOrchestrationDb()
    db.tasks.set('task-a', { id: 'task-a', status: 'ready', result: null })
    const pipelineDb = new FakePipelineRunDb(
      runRow(),
      new Map([['a', nodeRow({ node_id: 'a', node_index: 0, task_id: 'task-a' })]])
    )
    const runtime = runtimeStub()

    let resolvePreflight: (value: { ok: true; agent: 'claude' }) => void = () => {
      throw new Error('resolvePreflight called before the mock ran')
    }
    validatePipelineNodeLaunchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePreflight = resolve
        })
    )

    const driver = new PipelineDriver({
      runtime,
      db: db.asOrchestrationDb(),
      pipelineDb: pipelineDb.asPipelineRunDb(),
      runId: 'run-1',
      definition: definitionOf([nodeA]),
      publisher: publisherStub() as unknown as PipelineSnapshotPublisher
    })

    driver.start()
    await flushAsync() // dispatch is now awaiting preflight; nothing has committed yet

    await driver.abort()
    expect(pipelineDb.updateRunState).toHaveBeenCalledWith('run-1', 'aborted')

    resolvePreflight({ ok: true, agent: 'claude' }) // the stale dispatch only proceeds after abort landed
    await flushAsync()

    expect(executeLocalWorkerStartMock).not.toHaveBeenCalled() // must never launch once abort landed first
    expect(pipelineDb.beginAttempt).not.toHaveBeenCalled()

    await advanceOneCycle()
    await advanceOneCycle()
    expect(executeLocalWorkerStartMock).not.toHaveBeenCalled()
    driver.stop()
  })

  it('pause: a dispatch still awaiting preflight when pause runs must not launch, and resume retries it fresh', async () => {
    const nodeA = node({ id: 'a', index: 0 })
    const db = new FakeOrchestrationDb()
    db.tasks.set('task-a', { id: 'task-a', status: 'ready', result: null })
    const pipelineDb = new FakePipelineRunDb(
      runRow(),
      new Map([['a', nodeRow({ node_id: 'a', node_index: 0, task_id: 'task-a' })]])
    )
    const runtime = runtimeStub()

    let resolvePreflight: (value: { ok: true; agent: 'claude' }) => void = () => {
      throw new Error('resolvePreflight called before the mock ran')
    }
    validatePipelineNodeLaunchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePreflight = resolve
        })
    )
    executeLocalWorkerStartMock.mockImplementation(async (args: { taskId: string }) => {
      db.tasks.get(args.taskId)!.status = 'dispatched'
      return workerStartResponse({ taskId: args.taskId, dispatchId: 'd-a', state: 'ready' })
    })

    const driver = new PipelineDriver({
      runtime,
      db: db.asOrchestrationDb(),
      pipelineDb: pipelineDb.asPipelineRunDb(),
      runId: 'run-1',
      definition: definitionOf([nodeA]),
      publisher: publisherStub() as unknown as PipelineSnapshotPublisher
    })

    driver.start()
    await flushAsync() // dispatch is now awaiting preflight; nothing has committed yet

    driver.pause()
    expect(pipelineDb.run.state).toBe('paused')

    resolvePreflight({ ok: true, agent: 'claude' }) // the stale dispatch only proceeds after pause landed
    await flushAsync()

    expect(executeLocalWorkerStartMock).not.toHaveBeenCalled() // must not launch once pause landed first
    expect(pipelineDb.beginAttempt).not.toHaveBeenCalled()

    driver.resume()
    await advanceOneCycle()

    expect(executeLocalWorkerStartMock).toHaveBeenCalledTimes(1) // resume dispatches the abandoned node fresh
    driver.stop()
  })

  it('stop(): detaches without writing any state', async () => {
    const nodeA = node({ id: 'a', index: 0 })
    const db = new FakeOrchestrationDb()
    db.tasks.set('task-a', { id: 'task-a', status: 'ready', result: null })
    const pipelineDb = new FakePipelineRunDb(
      runRow(),
      new Map([['a', nodeRow({ node_id: 'a', node_index: 0, task_id: 'task-a' })]])
    )
    const runtime = runtimeStub()
    executeLocalWorkerStartMock.mockImplementation(async (args: { taskId: string }) => {
      db.tasks.get(args.taskId)!.status = 'dispatched'
      return workerStartResponse({ taskId: args.taskId, dispatchId: 'd-a', state: 'ready' })
    })

    const driver = new PipelineDriver({
      runtime,
      db: db.asOrchestrationDb(),
      pipelineDb: pipelineDb.asPipelineRunDb(),
      runId: 'run-1',
      definition: definitionOf([nodeA]),
      publisher: publisherStub() as unknown as PipelineSnapshotPublisher
    })

    driver.start()
    await flushAsync()

    driver.stop()
    expect(pipelineDb.updateRunState).not.toHaveBeenCalled()

    await advanceOneCycle()
    await advanceOneCycle()
    expect(executeLocalWorkerStartMock).toHaveBeenCalledTimes(1) // no ticks after stop()
  })
})
