/**
 * The advisory `limits.maxMinutes` badge is purely informational (C8/E5): breaching it must never
 * interrupt, stop, or otherwise act on the running node, and the run must still complete normally
 * once the node's own attempt resolves.
 */
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

describe('PipelineDriver advisory limit', () => {
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

  it('takes no interrupt/stop action while a node runs well past its advisory limit, and the run still completes normally', async () => {
    const theNode = node({ id: 'n', index: 0, limits: { maxMinutes: 0.01 } }) // 0.6s
    const db = new FakeOrchestrationDb()
    db.tasks.set('task-n', { id: 'task-n', status: 'ready', result: null })
    const pipelineDb = new FakePipelineRunDb(
      runRow(),
      new Map([['n', nodeRow({ node_id: 'n', node_index: 0, task_id: 'task-n' })]])
    )
    const runtime = runtimeStub()

    executeLocalWorkerStartMock.mockImplementation(async (args: { taskId: string }) => {
      db.tasks.get(args.taskId)!.status = 'dispatched'
      return workerStartResponse({
        taskId: args.taskId,
        dispatchId: 'd-n',
        state: 'ready',
        effects: [{ kind: 'terminal', role: 'agent', action: 'created', id: 'term-n' }]
      })
    })

    const driver = new PipelineDriver({
      runtime,
      db: db.asOrchestrationDb(),
      pipelineDb: pipelineDb.asPipelineRunDb(),
      runId: 'run-1',
      definition: definitionOf([theNode]),
      publisher: publisherStub() as unknown as PipelineSnapshotPublisher
    })

    driver.start()
    await flushAsync() // dispatches n

    // ten driver cycles (10s) is well past the 0.6s advisory limit; the node stays "dispatched"
    for (let i = 0; i < 10; i++) {
      await advanceOneCycle()
    }

    expect(runtime.sendTerminal).not.toHaveBeenCalled()
    expect(pipelineDb.run.state).toBe('running')

    db.tasks.set('task-n', { id: 'task-n', status: 'completed', result: 'ok' })
    await advanceOneCycle()

    expect(pipelineDb.run.state).toBe('completed')
    driver.stop()
  })
})
