/**
 * The mechanism behind forward-only folder-mode runs: a folder workspace's run context carries no
 * checkpoint backend at all, so the dispatch/retry paths — which only ever call a checkpoint backend
 * when one is present — structurally never capture or restore in folder mode.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/types'
import type { OrcaRuntimeService } from '../orca-runtime'
import { runRow } from './pipeline-driver-test-support'

const getSshGitProviderMock = vi.fn()
const getActiveMultiplexerMock = vi.fn()

vi.mock('../../ipc/ssh', () => ({
  getActiveMultiplexer: getActiveMultiplexerMock,
  getRegisteredSshState: vi.fn()
}))
vi.mock('../../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock,
  requireSshGitProvider: vi.fn(),
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE: 'Remote connection dropped.'
}))

const { resolvePipelineDriverRunContext } = await import('./pipeline-driver-run-context')

function runtimeStub(overrides: Partial<OrcaRuntimeService> = {}): OrcaRuntimeService {
  return {
    showManagedWorktree: vi
      .fn()
      .mockResolvedValue({ id: 'wt_run', repoId: 'repo_1', git: { path: '/tmp/worktree-1' } }),
    showRepo: vi.fn().mockResolvedValue({
      id: 'repo_1',
      path: '/repo',
      displayName: 'my-repo',
      badgeColor: '#000',
      addedAt: 0,
      kind: 'git'
    } as Repo),
    resolveProjectRuntimeForWorktree: vi.fn().mockReturnValue(undefined),
    ...overrides
  } as unknown as OrcaRuntimeService
}

describe('resolvePipelineDriverRunContext', () => {
  it('folder mode: never wires a checkpoint backend or worktree path', async () => {
    const runtime = runtimeStub()
    const run = runRow({ run_worktree_id: null, workspace_id: 'wt_origin' })

    const context = await resolvePipelineDriverRunContext(runtime, run)

    expect(context.isFolderMode).toBe(true)
    expect(context.checkpointBackend).toBeUndefined()
    expect(context.worktreePath).toBeUndefined()
  })

  it('git mode: wires a checkpoint backend and the worktree path', async () => {
    const runtime = runtimeStub()
    const run = runRow({ run_worktree_id: 'wt_run', workspace_id: 'wt_origin' })

    const context = await resolvePipelineDriverRunContext(runtime, run)

    expect(context.isFolderMode).toBe(false)
    expect(context.checkpointBackend).toBeDefined()
    expect(context.worktreePath).toBe('/tmp/worktree-1')
  })

  it('falls back to the originating workspace id when no run worktree was ever recorded (never dispatched past setup)', async () => {
    const runtime = runtimeStub()
    const run = runRow({ run_worktree_id: null, workspace_id: 'wt_origin' })

    await resolvePipelineDriverRunContext(runtime, run)

    expect(runtime.showManagedWorktree).toHaveBeenCalledWith('id:wt_origin')
  })
})
