import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { createPipelineRunsSlice, type PipelineRunsSlice } from './pipeline-runs'

const HYDRATION_DEADLINE_MS = 30_000

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  getRuntimeEnvironmentIdForWorktree: vi.fn(() => null as string | null)
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: mocks.getRuntimeEnvironmentIdForWorktree
}))

function createTestStore() {
  return create<PipelineRunsSlice>()((...args) => {
    const wideArgs = args as Parameters<typeof createPipelineRunsSlice>
    return createPipelineRunsSlice(...wideArgs) as PipelineRunsSlice
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  mocks.callRuntimeRpc.mockReset().mockResolvedValue({ runs: [] })
  mocks.getRuntimeEnvironmentIdForWorktree.mockReset().mockReturnValue(null)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('requestPipelineRunHydration', () => {
  it('marks the workspace in-flight and returns a generation', () => {
    const store = createTestStore()
    const generation = store.getState().requestPipelineRunHydration('w1')
    expect(store.getState().pipelineRunHydrationByWorkspaceId.w1).toEqual({
      phase: 'in-flight',
      startedAt: Date.now(),
      generation
    })
  })

  it('does not re-fire (or bump the generation) for a fresh in-flight request', () => {
    const store = createTestStore()
    const first = store.getState().requestPipelineRunHydration('w1')
    vi.advanceTimersByTime(HYDRATION_DEADLINE_MS - 1)
    const second = store.getState().requestPipelineRunHydration('w1')
    expect(second).toBe(first)
    expect(store.getState().pipelineRunHydrationByWorkspaceId.w1).toMatchObject({
      phase: 'in-flight',
      generation: first
    })
  })

  it('treats an in-flight entry past the 30s deadline as re-requestable', () => {
    const store = createTestStore()
    const first = store.getState().requestPipelineRunHydration('w1')
    vi.advanceTimersByTime(HYDRATION_DEADLINE_MS + 1)
    const second = store.getState().requestPipelineRunHydration('w1')
    expect(second).toBeGreaterThan(first)
    expect(store.getState().pipelineRunHydrationByWorkspaceId.w1).toMatchObject({
      phase: 'in-flight',
      generation: second,
      startedAt: Date.now()
    })
  })

  it('leaves a failed workspace re-requestable with a fresh, greater generation', () => {
    const store = createTestStore()
    const first = store.getState().requestPipelineRunHydration('w1')
    store.getState().markPipelineRunHydrationFailed('w1', first)
    expect(store.getState().pipelineRunHydrationByWorkspaceId.w1).toEqual({ phase: 'failed' })

    const second = store.getState().requestPipelineRunHydration('w1')
    expect(second).toBeGreaterThan(first)
    expect(store.getState().pipelineRunHydrationByWorkspaceId.w1).toMatchObject({
      phase: 'in-flight',
      generation: second
    })
  })
})

describe('firing pipeline.listRuns', () => {
  it('fires the RPC against a local target when requesting hydration', () => {
    const store = createTestStore()
    store.getState().requestPipelineRunHydration('w1')

    expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(1)
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, 'pipeline.listRuns')
  })

  it('fires the RPC against the resolved environment target for a remote worktree', () => {
    mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue('env-1')
    const store = createTestStore()
    store.getState().requestPipelineRunHydration('w1')

    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'pipeline.listRuns'
    )
  })

  it('does not fire a second RPC call for a fresh in-flight request', () => {
    const store = createTestStore()
    store.getState().requestPipelineRunHydration('w1')
    store.getState().requestPipelineRunHydration('w1')

    expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(1)
  })

  it('routes a successful completion to hydratePipelineRuns with the request generation', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({
      runs: [{ runId: 'r1', templateName: 'bugfix-fast', runNumber: 1, state: 'running' }]
    })
    const store = createTestStore()
    store.getState().requestPipelineRunHydration('w1')
    // the slice's own .then() is registered on this same promise before ours, so
    // awaiting it guarantees hydratePipelineRuns has already run by the time we resume.
    await mocks.callRuntimeRpc.mock.results[0]!.value

    expect(store.getState().pipelineRunHydrationByWorkspaceId.w1).toEqual({ phase: 'hydrated' })
    expect(store.getState().pipelineRunsById.r1).toMatchObject({ runId: 'r1', state: 'running' })
  })

  it('routes a rejected completion to markPipelineRunHydrationFailed', async () => {
    mocks.callRuntimeRpc.mockRejectedValue(new Error('host unreachable'))
    const store = createTestStore()
    store.getState().requestPipelineRunHydration('w1')
    await mocks.callRuntimeRpc.mock.results[0]!.value.catch(() => {})

    expect(store.getState().pipelineRunHydrationByWorkspaceId.w1).toEqual({ phase: 'failed' })
  })
})

describe('generation-guarded completion', () => {
  it('discards a stale-generation success: no run-map write, no phase flip', () => {
    const store = createTestStore()
    const staleGeneration = store.getState().requestPipelineRunHydration('w1')
    // demote-and-refire: the original request is still out there when a fresh cycle starts
    vi.advanceTimersByTime(HYDRATION_DEADLINE_MS + 1)
    const currentGeneration = store.getState().requestPipelineRunHydration('w1')
    expect(currentGeneration).not.toBe(staleGeneration)

    store
      .getState()
      .hydratePipelineRuns('w1', staleGeneration, [
        { runId: 'r1', templateName: 'bugfix-fast', runNumber: 1, state: 'running' }
      ])

    expect(store.getState().pipelineRunsById).toEqual({})
    expect(store.getState().pipelineRunHydrationByWorkspaceId.w1).toMatchObject({
      phase: 'in-flight',
      generation: currentGeneration
    })
  })

  it('discards a stale-generation failure: phase does not become failed', () => {
    const store = createTestStore()
    const staleGeneration = store.getState().requestPipelineRunHydration('w1')
    vi.advanceTimersByTime(HYDRATION_DEADLINE_MS + 1)
    const currentGeneration = store.getState().requestPipelineRunHydration('w1')

    store.getState().markPipelineRunHydrationFailed('w1', staleGeneration)

    expect(store.getState().pipelineRunHydrationByWorkspaceId.w1).toMatchObject({
      phase: 'in-flight',
      generation: currentGeneration
    })
  })

  it('applies a current-generation success: upserts entries and marks hydrated', () => {
    const store = createTestStore()
    const generation = store.getState().requestPipelineRunHydration('w1')

    store
      .getState()
      .hydratePipelineRuns('w1', generation, [
        {
          runId: 'r1',
          templateName: 'bugfix-fast',
          runNumber: 1,
          state: 'running',
          workspaceId: 'w1'
        }
      ])

    expect(store.getState().pipelineRunHydrationByWorkspaceId.w1).toEqual({ phase: 'hydrated' })
    expect(store.getState().pipelineRunsById.r1).toEqual({
      runId: 'r1',
      templateName: 'bugfix-fast',
      runNumber: 1,
      state: 'running',
      workspaceId: 'w1',
      lastSnapshotAt: null
    })
  })
})

describe('runs are never removed', () => {
  it('keeps a run absent from a later hydration list', () => {
    const store = createTestStore()
    const firstGeneration = store.getState().requestPipelineRunHydration('w1')
    store
      .getState()
      .hydratePipelineRuns('w1', firstGeneration, [
        { runId: 'r1', templateName: 'bugfix-fast', runNumber: 1, state: 'completed' }
      ])

    const secondGeneration = store.getState().requestPipelineRunHydration('w1')
    store
      .getState()
      .hydratePipelineRuns('w1', secondGeneration, [
        { runId: 'r2', templateName: 'bugfix-fast', runNumber: 2, state: 'running' }
      ])

    expect(Object.keys(store.getState().pipelineRunsById).sort()).toEqual(['r1', 'r2'])
  })

  it('keeps a run through a failed hydration', () => {
    const store = createTestStore()
    const generation = store.getState().requestPipelineRunHydration('w1')
    store
      .getState()
      .hydratePipelineRuns('w1', generation, [
        { runId: 'r1', templateName: 'bugfix-fast', runNumber: 1, state: 'completed' }
      ])

    const nextGeneration = store.getState().requestPipelineRunHydration('w1')
    store.getState().markPipelineRunHydrationFailed('w1', nextGeneration)

    expect(store.getState().pipelineRunsById.r1).toBeDefined()
  })
})

describe('seedPipelineRunWorkspace', () => {
  it('records the owning workspace for a run the store has never seen', () => {
    const store = createTestStore()
    store.getState().seedPipelineRunWorkspace({
      runId: 'r1',
      workspaceId: 'w1',
      templateName: 'bugfix-fast',
      runNumber: 5
    })

    expect(store.getState().pipelineRunsById.r1).toEqual({
      runId: 'r1',
      templateName: 'bugfix-fast',
      runNumber: 5,
      state: 'unknown',
      workspaceId: 'w1',
      lastSnapshotAt: null
    })
  })

  it('does not clobber richer state already learned from hydration or a snapshot', () => {
    const store = createTestStore()
    store.getState().upsertPipelineRunFromSnapshot({ runId: 'r1', state: 'running' })

    store.getState().seedPipelineRunWorkspace({
      runId: 'r1',
      workspaceId: 'w1',
      templateName: 'bugfix-fast',
      runNumber: 5
    })

    expect(store.getState().pipelineRunsById.r1).toMatchObject({
      state: 'running',
      workspaceId: 'w1'
    })
  })

  it('overwrites a stale workspaceId with the caller-known owner', () => {
    const store = createTestStore()
    store.getState().seedPipelineRunWorkspace({
      runId: 'r1',
      workspaceId: 'w-old',
      templateName: 'bugfix-fast',
      runNumber: 5
    })

    store.getState().seedPipelineRunWorkspace({
      runId: 'r1',
      workspaceId: 'w-new',
      templateName: 'bugfix-fast',
      runNumber: 5
    })

    expect(store.getState().pipelineRunsById.r1.workspaceId).toBe('w-new')
  })
})

describe('upsertPipelineRunFromSnapshot', () => {
  it('upserts a run independently of the hydration/listRuns path', () => {
    const store = createTestStore()
    store.getState().upsertPipelineRunFromSnapshot({
      runId: 'r1',
      templateName: 'bugfix-fast',
      runNumber: 3,
      state: 'running'
    })

    expect(store.getState().pipelineRunsById.r1).toEqual({
      runId: 'r1',
      templateName: 'bugfix-fast',
      runNumber: 3,
      state: 'running',
      workspaceId: null,
      lastSnapshotAt: Date.now()
    })
    expect(store.getState().pipelineRunHydrationByWorkspaceId).toEqual({})
  })

  it('preserves workspaceId learned from hydration when a snapshot never carries one', () => {
    const store = createTestStore()
    const generation = store.getState().requestPipelineRunHydration('w1')
    store
      .getState()
      .hydratePipelineRuns('w1', generation, [
        {
          runId: 'r1',
          templateName: 'bugfix-fast',
          runNumber: 1,
          state: 'running',
          workspaceId: 'w1'
        }
      ])

    store.getState().upsertPipelineRunFromSnapshot({ runId: 'r1', state: 'paused' })

    expect(store.getState().pipelineRunsById.r1).toMatchObject({
      workspaceId: 'w1',
      state: 'paused',
      templateName: 'bugfix-fast',
      runNumber: 1
    })
  })

  it('decodes an unrecognized state tag to unknown instead of throwing', () => {
    const store = createTestStore()
    store.getState().upsertPipelineRunFromSnapshot({ runId: 'r1', state: 'some-future-state' })
    expect(store.getState().pipelineRunsById.r1.state).toBe('unknown')
  })
})
