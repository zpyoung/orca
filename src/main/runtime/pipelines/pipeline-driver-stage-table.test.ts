import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FakeOrchestrationDb,
  FakePipelineRunDb,
  definitionOf,
  fakeCheckpointBackend,
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

type Harness = {
  driver: InstanceType<typeof PipelineDriver>
  db: FakeOrchestrationDb
  pipelineDb: FakePipelineRunDb
  runtime: ReturnType<typeof runtimeStub>
  checkpointBackend: ReturnType<typeof fakeCheckpointBackend>
}

function buildSingleNodeHarness(args: {
  retries?: number
  folderMode?: boolean
  runtimeOverrides?: Parameters<typeof runtimeStub>[0]
}): Harness {
  const theNode = node({ id: 'n', index: 0, onFailure: { retries: args.retries ?? 0 } })
  const db = new FakeOrchestrationDb()
  db.tasks.set('task-n', { id: 'task-n', status: 'ready', result: null })
  const pipelineDb = new FakePipelineRunDb(
    runRow(),
    new Map([
      [
        'n',
        nodeRow({
          node_id: 'n',
          node_index: 0,
          task_id: 'task-n',
          retries_allowed: args.retries ?? 0
        })
      ]
    ])
  )
  const runtime = runtimeStub(args.runtimeOverrides)
  const checkpointBackend = fakeCheckpointBackend()

  resolveContextMock.mockResolvedValue(
    args.folderMode
      ? { dispatchWorktreeId: 'worktree-1', isFolderMode: true, host: {} }
      : {
          dispatchWorktreeId: 'worktree-1',
          isFolderMode: false,
          host: {},
          worktreePath: '/tmp/worktree-1',
          checkpointBackend
        }
  )

  const driver = new PipelineDriver({
    runtime,
    db: db.asOrchestrationDb(),
    pipelineDb: pipelineDb.asPipelineRunDb(),
    runId: 'run-1',
    definition: definitionOf([theNode]),
    publisher: publisherStub() as unknown as PipelineSnapshotPublisher
  })

  return { driver, db, pipelineDb, runtime, checkpointBackend }
}

describe('PipelineDriver stage table (attempt accounting by evidence)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    validatePipelineNodeLaunchMock.mockReset().mockResolvedValue({ ok: true, agent: 'claude' })
    executeLocalWorkerStartMock.mockReset()
    resolveContextMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('stage A: a pre-spawn revalidation refusal consumes no attempt and fails the node terminally', async () => {
    validatePipelineNodeLaunchMock.mockResolvedValue({
      ok: false,
      nodeId: 'n',
      field: 'harness',
      message: 'agent disabled'
    })
    const { driver, pipelineDb } = buildSingleNodeHarness({})

    driver.start()
    await flushAsync()

    expect(executeLocalWorkerStartMock).not.toHaveBeenCalled()
    expect(pipelineDb.beginAttempt).not.toHaveBeenCalled()
    expect(pipelineDb.nodesById.get('n')?.outcome).toBe('failed')
    expect(pipelineDb.nodesById.get('n')?.outcome_reason).toContain('launch-rejected')
    expect(pipelineDb.run.state).toBe('failed')
    driver.stop()
  })

  it('stage B: budgets exactly 2 prelaunch re-dispatches, creates no attempt rows, and fails on the 3rd', async () => {
    const { driver, db, pipelineDb } = buildSingleNodeHarness({})
    executeLocalWorkerStartMock.mockImplementation(async (args: { taskId: string }) => {
      const dispatchId = `d-${db.dispatches.size}`
      // no spawn receipt registered: durable proof nothing spawned
      return workerStartResponse({ taskId: args.taskId, dispatchId, state: 'failed', effects: [] })
    })

    driver.start()
    await flushAsync()
    await advanceOneCycle()
    await advanceOneCycle()

    expect(executeLocalWorkerStartMock).toHaveBeenCalledTimes(3)
    expect(pipelineDb.beginAttempt).not.toHaveBeenCalled()
    expect(pipelineDb.endAttempt).not.toHaveBeenCalled()
    expect(pipelineDb.incrementPrelaunchFailures).toHaveBeenCalledTimes(3)
    expect(pipelineDb.nodesById.get('n')?.outcome).toBe('failed')
    expect(pipelineDb.nodesById.get('n')?.outcome_reason).toContain('prelaunch failures exhausted')
    expect(pipelineDb.run.state).toBe('failed')
    driver.stop()
  })

  it('stage B: the consecutive-failure counter resets once a dispatch reaches spawn commit', async () => {
    const { driver, db, pipelineDb } = buildSingleNodeHarness({})
    let call = 0
    executeLocalWorkerStartMock.mockImplementation(async (args: { taskId: string }) => {
      call += 1
      const dispatchId = `d-${call}`
      if (call === 1) {
        return workerStartResponse({
          taskId: args.taskId,
          dispatchId,
          state: 'failed',
          effects: []
        })
      }
      db.tasks.get(args.taskId)!.status = 'dispatched'
      return workerStartResponse({ taskId: args.taskId, dispatchId, state: 'ready' })
    })

    driver.start()
    await flushAsync()
    await advanceOneCycle() // redispatch after the first stage-B failure

    expect(pipelineDb.incrementPrelaunchFailures).toHaveBeenCalledTimes(1)
    expect(pipelineDb.resetPrelaunchFailures).toHaveBeenCalledTimes(1)
    expect(pipelineDb.nodesById.get('n')?.prelaunch_failures).toBe(0)
    driver.stop()
  })

  it('stage C: a verified stop (stopAndWait === true) restores the checkpoint before re-dispatch', async () => {
    const { driver, db, pipelineDb, runtime, checkpointBackend } = buildSingleNodeHarness({
      retries: 1
    })
    let call = 0
    executeLocalWorkerStartMock.mockImplementation(
      async (args: { taskId: string; retryOf?: string }) => {
        call += 1
        if (call === 1) {
          db.tasks.get(args.taskId)!.status = 'dispatched'
          return workerStartResponse({
            taskId: args.taskId,
            dispatchId: 'dispatch-1',
            state: 'ready'
          })
        }
        expect(args.retryOf).toBe('dispatch-1') // Route 1: retryOf is the failed dispatch id directly
        db.tasks.get(args.taskId)!.status = 'dispatched'
        return workerStartResponse({
          taskId: args.taskId,
          dispatchId: 'dispatch-2',
          state: 'ready'
        })
      }
    )

    driver.start()
    await flushAsync() // dispatch attempt 1

    // simulate a later-discovered stage-C failure: a terminal existed (spawn committed)
    db.registerDispatch({
      dispatchId: 'dispatch-1',
      taskId: 'task-n',
      workerState: 'failed',
      spawnReceipt: { committed: true }
    })
    db.tasks.set('task-n', { id: 'task-n', status: 'failed', result: null })
    await advanceOneCycle() // observe the failure, verify stop, restore, prepare retry

    expect(runtime.waitForLeafPtyId).toHaveBeenCalledWith('term-1', expect.any(Number))
    expect(checkpointBackend.restore).toHaveBeenCalledWith({
      worktreePath: '/tmp/worktree-1',
      head: 'head-1',
      snapshot: 'snapshot-1'
    })
    expect(pipelineDb.endAttempt).toHaveBeenCalledWith('run-1', 'n', 1, {
      outcome: 'failed',
      failureStage: 'C'
    })

    await advanceOneCycle() // dispatch attempt 2
    expect(executeLocalWorkerStartMock).toHaveBeenCalledTimes(2)
    expect(checkpointBackend.capture).toHaveBeenCalledTimes(2)
    // restore must precede the fresh checkpoint capture for the retry
    const restoreOrder = checkpointBackend.restore.mock.invocationCallOrder[0]
    const secondCaptureOrder = checkpointBackend.capture.mock.invocationCallOrder[1]
    expect(restoreOrder).toBeLessThan(secondCaptureOrder)

    db.tasks.set('task-n', { id: 'task-n', status: 'completed', result: 'ok' })
    await advanceOneCycle()
    expect(pipelineDb.run.state).toBe('completed')
    driver.stop()
  })

  it('stage C: an unconfirmed stop (stopAndWait === false) fails the node terminally without restoring or retrying', async () => {
    const { driver, db, pipelineDb, checkpointBackend } = buildSingleNodeHarness({
      retries: 1,
      runtimeOverrides: {
        stopExactTerminalsForWorktree: vi.fn().mockResolvedValue({
          stopped: 0,
          stoppedPtyIds: [],
          livePtyIds: ['pty-1'],
          postStopVerified: false
        })
      }
    })
    executeLocalWorkerStartMock.mockImplementation(async (args: { taskId: string }) => {
      db.tasks.get(args.taskId)!.status = 'dispatched'
      return workerStartResponse({ taskId: args.taskId, dispatchId: 'dispatch-1', state: 'ready' })
    })

    driver.start()
    await flushAsync()

    db.registerDispatch({
      dispatchId: 'dispatch-1',
      taskId: 'task-n',
      workerState: 'failed',
      spawnReceipt: { committed: true }
    })
    db.tasks.set('task-n', { id: 'task-n', status: 'failed', result: null })
    await advanceOneCycle()

    expect(checkpointBackend.restore).not.toHaveBeenCalled()
    expect(executeLocalWorkerStartMock).toHaveBeenCalledTimes(1) // no retry dispatch
    expect(pipelineDb.nodesById.get('n')?.outcome).toBe('failed')
    expect(pipelineDb.run.state).toBe('failed')
    driver.stop()
  })

  it('stage U: reconciles to B via the stop-flow bridge when no spawn-attempt row exists', async () => {
    const { driver, db, pipelineDb } = buildSingleNodeHarness({})
    let call = 0
    executeLocalWorkerStartMock.mockImplementation(
      async (args: { taskId: string; retryOf?: string }) => {
        call += 1
        if (call === 1) {
          db.registerDispatch({
            dispatchId: 'dispatch-u',
            taskId: args.taskId,
            workerState: 'start_unknown'
          })
          return workerStartResponse({
            taskId: args.taskId,
            dispatchId: 'dispatch-u',
            state: 'outcome_unknown',
            effects: []
          })
        }
        expect(args.retryOf).toBe('dispatch-u') // Route 2: bridged, then retryOf accepted
        db.tasks.get(args.taskId)!.status = 'dispatched'
        return workerStartResponse({
          taskId: args.taskId,
          dispatchId: 'dispatch-2',
          state: 'ready'
        })
      }
    )

    driver.start()
    await flushAsync()

    expect(db.beginWorkerStop).toHaveBeenCalledWith('dispatch-u')
    expect(db.settleWorkerStop).toHaveBeenCalledWith('dispatch-u')
    expect(pipelineDb.beginAttempt).not.toHaveBeenCalled() // resolved to B: no attempt row
    expect(pipelineDb.incrementPrelaunchFailures).toHaveBeenCalledTimes(1)

    await advanceOneCycle() // consumes the bridged retry
    expect(executeLocalWorkerStartMock).toHaveBeenCalledTimes(2)
    driver.stop()
  })

  it('stage U: reconciles to C via the stop-flow bridge when a spawn-attempt row exists', async () => {
    const { driver, db, pipelineDb } = buildSingleNodeHarness({ retries: 1 })
    let call = 0
    executeLocalWorkerStartMock.mockImplementation(
      async (args: { taskId: string; retryOf?: string }) => {
        call += 1
        if (call === 1) {
          db.registerDispatch({
            dispatchId: 'dispatch-u',
            taskId: args.taskId,
            workerState: 'start_unknown',
            spawnReceipt: { committed: false }
          })
          return workerStartResponse({
            taskId: args.taskId,
            dispatchId: 'dispatch-u',
            state: 'outcome_unknown'
          })
        }
        expect(args.retryOf).toBe('dispatch-u')
        db.tasks.get(args.taskId)!.status = 'dispatched'
        return workerStartResponse({
          taskId: args.taskId,
          dispatchId: 'dispatch-2',
          state: 'ready'
        })
      }
    )

    driver.start()
    await flushAsync()

    expect(db.beginWorkerStop).toHaveBeenCalledWith('dispatch-u')
    expect(db.settleWorkerStop).toHaveBeenCalledWith('dispatch-u')
    // resolved to C (conservative default): an attempt row is created and closed as failed
    expect(pipelineDb.beginAttempt).toHaveBeenCalledWith(
      'run-1',
      'n',
      expect.objectContaining({ attempt: 1 })
    )
    expect(pipelineDb.endAttempt).toHaveBeenCalledWith('run-1', 'n', 1, {
      outcome: 'failed',
      failureStage: 'C'
    })

    await advanceOneCycle()
    expect(executeLocalWorkerStartMock).toHaveBeenCalledTimes(2)
    driver.stop()
  })

  it('folder mode: retries perform no checkpoint restore between attempts', async () => {
    const { driver, db, pipelineDb } = buildSingleNodeHarness({ retries: 1, folderMode: true })
    let call = 0
    executeLocalWorkerStartMock.mockImplementation(
      async (args: { taskId: string; retryOf?: string }) => {
        call += 1
        db.tasks.get(args.taskId)!.status = call === 1 ? 'dispatched' : 'dispatched'
        return workerStartResponse({
          taskId: args.taskId,
          dispatchId: `dispatch-${call}`,
          state: 'ready'
        })
      }
    )

    driver.start()
    await flushAsync() // dispatch attempt 1

    db.registerDispatch({
      dispatchId: 'dispatch-1',
      taskId: 'task-n',
      workerState: 'failed',
      spawnReceipt: { committed: true }
    })
    db.tasks.set('task-n', { id: 'task-n', status: 'failed', result: null })
    await advanceOneCycle() // observe failure; folder mode has no backend to restore
    await advanceOneCycle() // dispatch attempt 2

    expect(executeLocalWorkerStartMock).toHaveBeenCalledTimes(2)
    expect(executeLocalWorkerStartMock.mock.calls[1][0]).toMatchObject({ retryOf: 'dispatch-1' })

    db.tasks.set('task-n', { id: 'task-n', status: 'completed', result: 'ok' })
    await advanceOneCycle()
    expect(pipelineDb.run.state).toBe('completed')
    driver.stop()
  })
})
