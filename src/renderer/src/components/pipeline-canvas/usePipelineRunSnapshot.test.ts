// @vitest-environment happy-dom

import { act } from 'react'
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PipelineRunSnapshotWire } from '../../../../shared/pipeline-run-snapshot'
import type { PipelineRunSubscriptionError } from '@/runtime/pipeline-run-client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const upsertPipelineRunFromSnapshot = vi.fn()

// keyed by worktreeId, standing in for the real resolver's indexed-worktree lookup
let runtimeEnvironmentIdByWorktreeId: Record<string, string> = {}
let pipelineRunsById: Record<string, { workspaceId: string | null }> = {}

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: (
    _state: unknown,
    worktreeId: string | null
  ): string | null => (worktreeId ? (runtimeEnvironmentIdByWorktreeId[worktreeId] ?? null) : null)
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      // deliberately a *different* environment than any workspace-owner mapping used below,
      // so a test that resolves to it instead of the run's own workspace owner is caught.
      settings: { activeRuntimeEnvironmentId: 'env-GLOBALLY-SELECTED' },
      pipelineRunsById,
      upsertPipelineRunFromSnapshot
    })
}))

let deliverSnapshot: ((snapshot: PipelineRunSnapshotWire) => void) | undefined
let deliverError: ((error: PipelineRunSubscriptionError) => void) | undefined
const unsubscribeMock = vi.fn()
const subscribeToPipelineRunSnapshot = vi.fn(
  async (
    _target: unknown,
    _runId: string,
    onSnapshot: (snapshot: PipelineRunSnapshotWire) => void,
    onError: (error: PipelineRunSubscriptionError) => void
  ) => {
    deliverSnapshot = onSnapshot
    deliverError = onError
    return { unsubscribe: unsubscribeMock }
  }
)

vi.mock('@/runtime/pipeline-run-client', () => ({
  subscribeToPipelineRunSnapshot: (...args: Parameters<typeof subscribeToPipelineRunSnapshot>) =>
    subscribeToPipelineRunSnapshot(...args)
}))

import { usePipelineRunSnapshot } from './usePipelineRunSnapshot'

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('usePipelineRunSnapshot', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    subscribeToPipelineRunSnapshot.mockClear()
    unsubscribeMock.mockClear()
    upsertPipelineRunFromSnapshot.mockClear()
    deliverSnapshot = undefined
    deliverError = undefined
    runtimeEnvironmentIdByWorktreeId = {}
    pipelineRunsById = {}
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts with no snapshot and not stale', async () => {
    const { result } = renderHook(() => usePipelineRunSnapshot('run-1'))
    await flushMicrotasks()
    expect(result.current.snapshot).toBeNull()
    expect(result.current.isStale).toBe(false)
  })

  it('feeds every received snapshot into the store', async () => {
    renderHook(() => usePipelineRunSnapshot('run-1'))
    await flushMicrotasks()
    const snapshot: PipelineRunSnapshotWire = {
      runId: 'run-1',
      state: 'running',
      publishedAt: new Date().toISOString()
    }
    act(() => deliverSnapshot?.(snapshot))
    expect(upsertPipelineRunFromSnapshot).toHaveBeenCalledWith(snapshot)
  })

  it('decodes an unrecognized run-state tag to unknown without throwing', async () => {
    const { result } = renderHook(() => usePipelineRunSnapshot('run-1'))
    await flushMicrotasks()
    const snapshot: PipelineRunSnapshotWire = {
      runId: 'run-1',
      state: 'some-future-state',
      publishedAt: new Date().toISOString()
    }
    expect(() => act(() => deliverSnapshot?.(snapshot))).not.toThrow()
    expect(result.current.runState).toBe('unknown')
  })

  it('marks stale once 15s pass with no new snapshot for a live run', async () => {
    const { result } = renderHook(() => usePipelineRunSnapshot('run-1'))
    await flushMicrotasks()
    act(() =>
      deliverSnapshot?.({ runId: 'run-1', state: 'running', publishedAt: new Date().toISOString() })
    )
    expect(result.current.isStale).toBe(false)

    act(() => vi.advanceTimersByTime(14_999))
    expect(result.current.isStale).toBe(false)

    act(() => vi.advanceTimersByTime(2))
    expect(result.current.isStale).toBe(true)
  })

  it('clears the stale indicator on the next received snapshot', async () => {
    const { result } = renderHook(() => usePipelineRunSnapshot('run-1'))
    await flushMicrotasks()
    act(() =>
      deliverSnapshot?.({ runId: 'run-1', state: 'running', publishedAt: new Date().toISOString() })
    )
    act(() => vi.advanceTimersByTime(15_000))
    expect(result.current.isStale).toBe(true)

    act(() =>
      deliverSnapshot?.({ runId: 'run-1', state: 'running', publishedAt: new Date().toISOString() })
    )
    expect(result.current.isStale).toBe(false)
  })

  it('never marks a terminal run stale, even long after its last snapshot', async () => {
    const { result } = renderHook(() => usePipelineRunSnapshot('run-1'))
    await flushMicrotasks()
    act(() =>
      deliverSnapshot?.({
        runId: 'run-1',
        state: 'completed',
        publishedAt: new Date().toISOString()
      })
    )
    act(() => vi.advanceTimersByTime(60_000))
    expect(result.current.isStale).toBe(false)
  })

  it('does not throw when the subscription reports an error', async () => {
    renderHook(() => usePipelineRunSnapshot('run-1'))
    await flushMicrotasks()
    expect(() =>
      act(() => deliverError?.({ kind: 'transient', message: 'boom' }))
    ).not.toThrow()
  })

  it('starts with no subscription error', async () => {
    const { result } = renderHook(() => usePipelineRunSnapshot('run-1'))
    await flushMicrotasks()
    expect(result.current.subscriptionError).toBeNull()
  })

  it('surfaces an unsupported-host subscription error distinctly from a transient one', async () => {
    const { result } = renderHook(() => usePipelineRunSnapshot('run-1'))
    await flushMicrotasks()
    act(() => deliverError?.({ kind: 'unsupported', message: 'this host has no pipelines' }))
    expect(result.current.subscriptionError).toEqual({
      kind: 'unsupported',
      message: 'this host has no pipelines'
    })
  })

  it('clears a subscription error once a snapshot arrives', async () => {
    const { result } = renderHook(() => usePipelineRunSnapshot('run-1'))
    await flushMicrotasks()
    act(() => deliverError?.({ kind: 'transient', message: 'boom' }))
    expect(result.current.subscriptionError).not.toBeNull()

    act(() =>
      deliverSnapshot?.({ runId: 'run-1', state: 'running', publishedAt: new Date().toISOString() })
    )
    expect(result.current.subscriptionError).toBeNull()
  })

  it('unsubscribes the prior run when runId changes, and resubscribes for the new one', async () => {
    const { rerender } = renderHook(({ runId }) => usePipelineRunSnapshot(runId), {
      initialProps: { runId: 'run-1' }
    })
    await flushMicrotasks()
    expect(subscribeToPipelineRunSnapshot).toHaveBeenCalledTimes(1)

    rerender({ runId: 'run-2' })
    await flushMicrotasks()
    expect(unsubscribeMock).toHaveBeenCalledTimes(1)
    expect(subscribeToPipelineRunSnapshot).toHaveBeenCalledTimes(2)
    const [, secondRunId] = subscribeToPipelineRunSnapshot.mock.calls[1]!
    expect(secondRunId).toBe('run-2')
  })

  it('unsubscribes on unmount', async () => {
    const { unmount } = renderHook(() => usePipelineRunSnapshot('run-1'))
    await flushMicrotasks()
    unmount()
    expect(unsubscribeMock).toHaveBeenCalledTimes(1)
  })

  it("subscribes to the run's owning workspace host, not the globally selected environment", async () => {
    pipelineRunsById = { 'run-1': { workspaceId: 'workspace-A' } }
    runtimeEnvironmentIdByWorktreeId = { 'workspace-A': 'env-A' }
    const { result } = renderHook(() => usePipelineRunSnapshot('run-1'))
    await flushMicrotasks()

    expect(subscribeToPipelineRunSnapshot).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-A' },
      'run-1',
      expect.any(Function),
      expect.any(Function)
    )
    expect(result.current.target).toEqual({ kind: 'environment', environmentId: 'env-A' })
  })

  it('targets local when the owning workspace resolves to no runtime environment, ignoring any globally selected one', async () => {
    pipelineRunsById = { 'run-1': { workspaceId: 'workspace-local' } }
    runtimeEnvironmentIdByWorktreeId = {} // workspace-local has no mapped environment: it's local

    const { result } = renderHook(() => usePipelineRunSnapshot('run-1'))
    await flushMicrotasks()

    expect(subscribeToPipelineRunSnapshot).toHaveBeenCalledWith(
      { kind: 'local' },
      'run-1',
      expect.any(Function),
      expect.any(Function)
    )
    expect(result.current.target).toEqual({ kind: 'local' })
  })

  it('re-resolves the target when the run id changes to one owned by a different workspace', async () => {
    pipelineRunsById = {
      'run-1': { workspaceId: 'workspace-A' },
      'run-2': { workspaceId: 'workspace-B' }
    }
    runtimeEnvironmentIdByWorktreeId = { 'workspace-A': 'env-A', 'workspace-B': 'env-B' }

    const { rerender } = renderHook(({ runId }) => usePipelineRunSnapshot(runId), {
      initialProps: { runId: 'run-1' }
    })
    await flushMicrotasks()
    expect(subscribeToPipelineRunSnapshot).toHaveBeenNthCalledWith(
      1,
      { kind: 'environment', environmentId: 'env-A' },
      'run-1',
      expect.any(Function),
      expect.any(Function)
    )

    rerender({ runId: 'run-2' })
    await flushMicrotasks()
    expect(subscribeToPipelineRunSnapshot).toHaveBeenNthCalledWith(
      2,
      { kind: 'environment', environmentId: 'env-B' },
      'run-2',
      expect.any(Function),
      expect.any(Function)
    )
  })
})
