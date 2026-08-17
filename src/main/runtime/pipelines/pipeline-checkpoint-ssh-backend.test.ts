import { describe, expect, it, vi } from 'vitest'
import { createSshCheckpointBackend } from './pipeline-checkpoint-ssh-backend'
import type { SshGitProvider } from '../../providers/ssh-git-provider'

function createMockProvider(): SshGitProvider {
  return {
    pipelineCheckpointCapture: vi.fn().mockResolvedValue({
      head: 'a'.repeat(40),
      snapshot: 'b'.repeat(40),
      ref: 'refs/orca/pipeline/run_1/node-1-1'
    }),
    pipelineCheckpointRestore: vi.fn().mockResolvedValue(undefined)
  } as unknown as SshGitProvider
}

describe('createSshCheckpointBackend', () => {
  it('capture calls the provider RPC and returns its result verbatim', async () => {
    const provider = createMockProvider()
    const backend = createSshCheckpointBackend(provider)

    const result = await backend.capture({
      worktreePath: '/repo',
      runId: 'run_1',
      nodeId: 'node-1',
      attempt: 1
    })

    expect(provider.pipelineCheckpointCapture).toHaveBeenCalledWith({
      worktreePath: '/repo',
      runId: 'run_1',
      nodeId: 'node-1',
      attempt: 1
    })
    expect(result).toEqual({
      head: 'a'.repeat(40),
      snapshot: 'b'.repeat(40),
      ref: 'refs/orca/pipeline/run_1/node-1-1'
    })
  })

  it('restore calls the provider RPC', async () => {
    const provider = createMockProvider()
    const backend = createSshCheckpointBackend(provider)

    await backend.restore({ worktreePath: '/repo', head: 'a'.repeat(40), snapshot: 'b'.repeat(40) })

    expect(provider.pipelineCheckpointRestore).toHaveBeenCalledWith({
      worktreePath: '/repo',
      head: 'a'.repeat(40),
      snapshot: 'b'.repeat(40)
    })
  })

  it('never calls SshGitProvider.exec', async () => {
    const provider = { ...createMockProvider(), exec: vi.fn() } as unknown as SshGitProvider
    const backend = createSshCheckpointBackend(provider)

    await backend.capture({ worktreePath: '/repo', runId: 'run_1', nodeId: 'node-1', attempt: 1 })
    await backend.restore({ worktreePath: '/repo', head: 'a'.repeat(40), snapshot: 'b'.repeat(40) })

    expect((provider as unknown as { exec: ReturnType<typeof vi.fn> }).exec).not.toHaveBeenCalled()
  })
})
