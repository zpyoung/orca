import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { createPipelineRunsSlice, type PipelineRunsSlice } from './pipeline-runs'

const HYDRATION_DEADLINE_MS = 30_000

function createTestStore() {
  return create<PipelineRunsSlice>()(createPipelineRunsSlice)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
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
