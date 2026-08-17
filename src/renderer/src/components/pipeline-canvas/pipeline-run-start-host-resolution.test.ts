// @vitest-environment happy-dom

import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// stands in for the real resolver: only 'workspace-remote' owns a runtime environment,
// matching how a freshly started run's workspace would resolve in the live app.
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: (_state: unknown, worktreeId: string | null): string | null =>
    worktreeId === 'workspace-remote' ? 'env-remote' : null
}))

const subscribeToPipelineRunSnapshot = vi.fn(async () => ({ unsubscribe: vi.fn() }))
vi.mock('@/runtime/pipeline-run-client', () => ({
  subscribeToPipelineRunSnapshot: (...args: Parameters<typeof subscribeToPipelineRunSnapshot>) =>
    subscribeToPipelineRunSnapshot(...args)
}))

import { ensurePipelineTab } from '@/lib/ensure-pipeline-tab'
import { usePipelineRunSnapshot } from './usePipelineRunSnapshot'

const initialAppState = useAppStore.getInitialState()

describe('resolving a pipeline canvas host for a just-started run', () => {
  beforeEach(() => {
    subscribeToPipelineRunSnapshot.mockClear()
    useAppStore.setState(
      {
        ...initialAppState,
        activeWorktreeId: 'workspace-remote',
        activeGroupIdByWorktree: { 'workspace-remote': 'group-1' },
        groupsByWorktree: {
          'workspace-remote': [
            { id: 'group-1', worktreeId: 'workspace-remote', activeTabId: null, tabOrder: [] }
          ]
        },
        unifiedTabsByWorktree: { 'workspace-remote': [] }
      },
      true
    )
  })

  afterEach(() => {
    useAppStore.setState(initialAppState, true)
  })

  it('subscribes to the owning remote host, never local, for a run absent from pipelineRunsById until the moment it starts', async () => {
    expect(useAppStore.getState().pipelineRunsById['run-new']).toBeUndefined()

    ensurePipelineTab('workspace-remote', {
      runId: 'run-new',
      runNumber: 1,
      templateName: 'bugfix-fast'
    })

    // the seed lands synchronously, before any render or hydration could supply it
    expect(useAppStore.getState().pipelineRunsById['run-new']).toMatchObject({
      workspaceId: 'workspace-remote'
    })

    renderHook(() => usePipelineRunSnapshot('run-new'))

    await waitFor(() => expect(subscribeToPipelineRunSnapshot).toHaveBeenCalledTimes(1))
    expect(subscribeToPipelineRunSnapshot).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-remote' },
      'run-new',
      expect.any(Function),
      expect.any(Function)
    )
  })
})
