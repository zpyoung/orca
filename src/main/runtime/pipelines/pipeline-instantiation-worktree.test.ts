import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../orca-runtime'
import { removePipelineRunWorktreeBestEffort } from './pipeline-instantiation-worktree'

function runtimeStub(overrides: Partial<OrcaRuntimeService> = {}): OrcaRuntimeService {
  return {
    removeManagedWorktree: vi.fn().mockResolvedValue({}),
    listManagedWorktrees: vi
      .fn()
      .mockResolvedValue({ worktrees: [], totalCount: 0, truncated: false }),
    ...overrides
  } as unknown as OrcaRuntimeService
}

describe('removePipelineRunWorktreeBestEffort', () => {
  it('removes the worktree the creator identified with a certain id', async () => {
    const runtime = runtimeStub()

    await removePipelineRunWorktreeBestEffort(runtime, { runWorktreeId: 'wt_run' })

    expect(runtime.removeManagedWorktree).toHaveBeenCalledWith('wt_run', true)
  })

  it('does nothing when no id came back, even if a worktree happens to sit on the branch that was asked for', async () => {
    const runtime = runtimeStub({
      listManagedWorktrees: vi.fn().mockResolvedValue({
        worktrees: [
          { id: 'wt_other', branch: 'refs/heads/pipeline/bugfix-fast-1', repoId: 'repo_1' }
        ],
        totalCount: 1,
        truncated: false
      })
    })

    await removePipelineRunWorktreeBestEffort(runtime, { runWorktreeId: undefined })

    // no fallback lookup at all: without a certain id there is nothing safe to act on
    expect(runtime.listManagedWorktrees).not.toHaveBeenCalled()
    expect(runtime.removeManagedWorktree).not.toHaveBeenCalled()
  })

  it('swallows a removal failure: best-effort must not throw', async () => {
    const runtime = runtimeStub({
      removeManagedWorktree: vi.fn().mockRejectedValue(new Error('worktree busy'))
    })

    await expect(
      removePipelineRunWorktreeBestEffort(runtime, { runWorktreeId: 'wt_run' })
    ).resolves.toBeUndefined()
  })
})
