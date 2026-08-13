import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import type { RpcContext, RpcMethod, RpcStreamingMethod } from '../core'

const startPipelineRunMock = vi.fn()
const pausePipelineRunMock = vi.fn()
const resumePipelineRunMock = vi.fn()
const abortPipelineRunMock = vi.fn()
const listPipelineRunsMock = vi.fn()
const subscribeToPipelineRunMock = vi.fn()

vi.mock('../../pipelines/pipeline-run-lifecycle', () => ({
  startPipelineRun: (...args: unknown[]) => startPipelineRunMock(...args),
  pausePipelineRun: (...args: unknown[]) => pausePipelineRunMock(...args),
  resumePipelineRun: (...args: unknown[]) => resumePipelineRunMock(...args),
  abortPipelineRun: (...args: unknown[]) => abortPipelineRunMock(...args),
  listPipelineRuns: (...args: unknown[]) => listPipelineRunsMock(...args),
  subscribeToPipelineRun: (...args: unknown[]) => subscribeToPipelineRunMock(...args)
}))

const { PIPELINE_METHODS } = await import('./pipelines')
const { PipelineStartParams } = await import('./pipelines-schema')

function methodNamed<T extends RpcMethod | RpcStreamingMethod>(name: string): T {
  const method = PIPELINE_METHODS.find((candidate) => candidate.name === name)
  if (!method) {
    throw new Error(`method not registered: ${name}`)
  }
  return method as T
}

function runtimeStub(): {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  cleanups: Map<string, () => void>
} {
  const db = { marker: 'fake-db' } as unknown as OrchestrationDb
  const cleanups = new Map<string, () => void>()
  const runtime = {
    getOrchestrationDb: vi.fn(() => db),
    registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
      cleanups.set(id, cleanup)
    }),
    cleanupSubscription: vi.fn((id: string) => {
      cleanups.get(id)?.()
      cleanups.delete(id)
    })
  } as unknown as OrcaRuntimeService
  return { runtime, db, cleanups }
}

function bareDefinition() {
  return { templateName: 't', templateVersion: 1, needsNewerOrca: false, inputText: '', nodes: [] }
}

beforeEach(() => {
  startPipelineRunMock.mockReset()
  pausePipelineRunMock.mockReset()
  resumePipelineRunMock.mockReset()
  abortPipelineRunMock.mockReset()
  listPipelineRunsMock.mockReset()
  subscribeToPipelineRunMock.mockReset()
})

describe('PIPELINE_METHODS registration', () => {
  it('registers exactly the documented pipeline method surface', () => {
    expect(PIPELINE_METHODS.map((method) => method.name).sort()).toEqual([
      'pipeline.abort',
      'pipeline.listRuns',
      'pipeline.pause',
      'pipeline.resume',
      'pipeline.start',
      'pipeline.subscribe',
      'pipeline.unsubscribe'
    ])
  })
})

describe('pipeline.start', () => {
  it('delegates to startPipelineRun and maps a success outcome to the start-result wire shape', async () => {
    startPipelineRunMock.mockResolvedValue({
      runId: 'run-1',
      runNumber: 2,
      branch: 'pipeline/x-2',
      runWorktreeId: 'wt-2'
    })
    const { runtime, db } = runtimeStub()
    const method = methodNamed<RpcMethod>('pipeline.start')
    const definition = bareDefinition()

    const result = await method.handler({ worktree: 'id:w1', definition }, {
      runtime
    } as RpcContext)

    expect(startPipelineRunMock).toHaveBeenCalledWith({
      runtime,
      db,
      worktreeSelector: 'id:w1',
      definition
    })
    // runWorktreeId is internal, not part of the PipelineStartResult wire shape
    expect(result).toEqual({ runId: 'run-1', runNumber: 2, branch: 'pipeline/x-2' })
  })

  it('folder-mode success omits branch entirely rather than emitting it as undefined', async () => {
    startPipelineRunMock.mockResolvedValue({ runId: 'run-1', runNumber: 1 })
    const { runtime } = runtimeStub()
    const method = methodNamed<RpcMethod>('pipeline.start')

    const result = await method.handler({ worktree: 'id:w1', definition: bareDefinition() }, {
      runtime
    } as RpcContext)

    expect(result).toEqual({ runId: 'run-1', runNumber: 1 })
    expect(result).not.toHaveProperty('branch')
  })

  it('maps a refusal through unchanged', async () => {
    startPipelineRunMock.mockResolvedValue({
      refused: { nodeId: 'n1', field: 'harness', message: 'bad harness' }
    })
    const { runtime } = runtimeStub()
    const method = methodNamed<RpcMethod>('pipeline.start')

    const result = await method.handler({ worktree: 'id:w1', definition: bareDefinition() }, {
      runtime
    } as RpcContext)

    expect(result).toEqual({ refused: { nodeId: 'n1', field: 'harness', message: 'bad harness' } })
  })
})

describe('pipeline.pause / pipeline.resume', () => {
  it('pipeline.pause delegates with runId and the runtime db', async () => {
    pausePipelineRunMock.mockReturnValue({ state: 'paused' })
    const { runtime, db } = runtimeStub()

    const result = await methodNamed<RpcMethod>('pipeline.pause').handler({ runId: 'run-1' }, {
      runtime
    } as RpcContext)

    expect(pausePipelineRunMock).toHaveBeenCalledWith('run-1', db)
    expect(result).toEqual({ state: 'paused' })
  })

  it('pipeline.resume delegates with runId and the runtime db', async () => {
    resumePipelineRunMock.mockReturnValue({ state: 'running' })
    const { runtime, db } = runtimeStub()

    const result = await methodNamed<RpcMethod>('pipeline.resume').handler({ runId: 'run-1' }, {
      runtime
    } as RpcContext)

    expect(resumePipelineRunMock).toHaveBeenCalledWith('run-1', db)
    expect(result).toEqual({ state: 'running' })
  })
})

describe('pipeline.abort', () => {
  it('awaits abortPipelineRun and returns its state', async () => {
    abortPipelineRunMock.mockResolvedValue({ state: 'aborted' })
    const { runtime, db } = runtimeStub()

    const result = await methodNamed<RpcMethod>('pipeline.abort').handler({ runId: 'run-1' }, {
      runtime
    } as RpcContext)

    expect(abortPipelineRunMock).toHaveBeenCalledWith('run-1', db)
    expect(result).toEqual({ state: 'aborted' })
  })
})

describe('pipeline.listRuns', () => {
  it('maps rows to the wire list-entry shape and passes an explicit workspaceId filter through', async () => {
    listPipelineRunsMock.mockReturnValue([
      {
        run_id: 'r1',
        template_name: 't',
        template_version: 1,
        run_number: 1,
        needs_newer_orca: 0,
        state: 'running',
        failure_reason: null,
        input_text: 'x',
        snapshot_json: '{}',
        workspace_id: 'w1',
        workspace_display_name: 'ws',
        base_commit: null,
        branch: null,
        run_worktree_id: null,
        created_at: 'now',
        updated_at: 'now',
        ended_at: null
      }
    ])
    const { runtime, db } = runtimeStub()

    const result = await methodNamed<RpcMethod>('pipeline.listRuns').handler(
      { workspaceId: 'w1' },
      { runtime } as RpcContext
    )

    expect(listPipelineRunsMock).toHaveBeenCalledWith(db, { workspaceId: 'w1' })
    expect(result).toEqual({
      runs: [
        {
          runId: 'r1',
          templateName: 't',
          runNumber: 1,
          state: 'running',
          workspaceDisplayName: 'ws',
          workspaceId: 'w1',
          createdAt: 'now'
        }
      ]
    })
  })

  it('omits the workspaceId filter when not provided', async () => {
    listPipelineRunsMock.mockReturnValue([])
    const { runtime, db } = runtimeStub()

    await methodNamed<RpcMethod>('pipeline.listRuns').handler({}, { runtime } as RpcContext)

    expect(listPipelineRunsMock).toHaveBeenCalledWith(db, undefined)
  })
})

describe('pipeline.subscribe / pipeline.unsubscribe', () => {
  it('attaches via subscribeToPipelineRun, tags every emission with a subscriptionId, and resolves only once unsubscribed', async () => {
    const unsubscribeSpy = vi.fn()
    let capturedEmit: ((snapshot: unknown) => void) | undefined
    subscribeToPipelineRunMock.mockImplementation((_db, _runId, emit) => {
      capturedEmit = emit
      emit({ runId: 'run-1', state: 'running' })
      return unsubscribeSpy
    })
    const { runtime, db, cleanups } = runtimeStub()
    const emitted: unknown[] = []
    const method = methodNamed<RpcStreamingMethod>('pipeline.subscribe')

    const done = method.handler(
      { runId: 'run-1' },
      { runtime, connectionId: 'conn-1' } as RpcContext,
      (value) => emitted.push(value)
    )
    await Promise.resolve()

    expect(subscribeToPipelineRunMock).toHaveBeenCalledWith(db, 'run-1', expect.any(Function))
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({
      runId: 'run-1',
      state: 'running',
      subscriptionId: expect.stringContaining('pipeline-subscribe-conn-1-')
    })
    const subscriptionId = (emitted[0] as { subscriptionId: string }).subscriptionId
    expect(runtime.registerSubscriptionCleanup).toHaveBeenCalledWith(
      subscriptionId,
      expect.any(Function),
      'conn-1'
    )
    expect(unsubscribeSpy).not.toHaveBeenCalled()

    // a later push through the captured emit callback still carries the same subscriptionId
    capturedEmit?.({ runId: 'run-1', state: 'completed' })
    expect(emitted[1]).toMatchObject({ subscriptionId, state: 'completed' })

    cleanups.get(subscriptionId)?.()
    expect(unsubscribeSpy).toHaveBeenCalledTimes(1)
    await done
  })

  it('propagates a run-not-found error before registering any cleanup', async () => {
    subscribeToPipelineRunMock.mockImplementation(() => {
      throw new Error('Pipeline run nope was not found.')
    })
    const { runtime } = runtimeStub()
    const method = methodNamed<RpcStreamingMethod>('pipeline.subscribe')

    await expect(
      method.handler({ runId: 'nope' }, { runtime, connectionId: 'conn-1' } as RpcContext, vi.fn())
    ).rejects.toThrow(/not found/i)
    expect(runtime.registerSubscriptionCleanup).not.toHaveBeenCalled()
  })

  it('pipeline.unsubscribe cleans up a subscription that belongs to this connection', () => {
    const { runtime } = runtimeStub()

    const result = methodNamed<RpcMethod>('pipeline.unsubscribe').handler(
      { subscriptionId: 'pipeline-subscribe-conn-1-7' },
      { runtime, connectionId: 'conn-1' } as RpcContext
    )

    expect(result).toEqual({ unsubscribed: true })
    expect(runtime.cleanupSubscription).toHaveBeenCalledWith('pipeline-subscribe-conn-1-7')
  })

  it('pipeline.unsubscribe refuses a subscription id minted for a different connection', () => {
    const { runtime } = runtimeStub()

    const result = methodNamed<RpcMethod>('pipeline.unsubscribe').handler(
      { subscriptionId: 'pipeline-subscribe-conn-OTHER-7' },
      { runtime, connectionId: 'conn-1' } as RpcContext
    )

    expect(result).toEqual({ unsubscribed: false })
    expect(runtime.cleanupSubscription).not.toHaveBeenCalled()
  })
})

describe('PipelineStartParams', () => {
  it('rejects params missing the worktree selector', () => {
    expect(PipelineStartParams.safeParse({ definition: bareDefinition() }).success).toBe(false)
  })

  it('rejects a node missing its harness', () => {
    const result = PipelineStartParams.safeParse({
      worktree: 'id:w1',
      definition: {
        ...bareDefinition(),
        nodes: [{ id: 'n1', title: 'N1', prompt: 'do it', index: 0, needs: [] }]
      }
    })
    expect(result.success).toBe(false)
  })

  it('accepts a well-formed start request', () => {
    const result = PipelineStartParams.safeParse({
      worktree: 'id:w1',
      definition: {
        ...bareDefinition(),
        nodes: [{ id: 'n1', title: 'N1', prompt: 'do it', index: 0, needs: [], harness: 'claude' }]
      }
    })
    expect(result.success).toBe(true)
  })
})
