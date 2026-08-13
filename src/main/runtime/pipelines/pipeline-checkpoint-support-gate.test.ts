import { describe, expect, it, vi } from 'vitest'
import { assertRelaySupportsPipelineCheckpoints } from './pipeline-checkpoint-support-gate'
import type { SshGitProvider } from '../../providers/ssh-git-provider'

function createMockProvider(supported: () => Promise<boolean>): SshGitProvider {
  return { pipelineCheckpointSupported: supported } as unknown as SshGitProvider
}

describe('assertRelaySupportsPipelineCheckpoints', () => {
  it('resolves ok when the relay supports the checkpoint RPCs', async () => {
    const provider = createMockProvider(async () => true)

    await expect(assertRelaySupportsPipelineCheckpoints(provider)).resolves.toEqual({ ok: true })
  })

  it('refuses with an update-the-relay message when the probe resolves false', async () => {
    const provider = createMockProvider(async () => false)

    const result = await assertRelaySupportsPipelineCheckpoints(provider)

    expect(result.ok).toBe(false)
    expect((result as { message: string }).message).toMatch(/update the remote orca/i)
  })

  it('refuses with a distinct connectivity message on transport failure', async () => {
    const provider = createMockProvider(() => Promise.reject(new Error('ECONNRESET')))

    const result = await assertRelaySupportsPipelineCheckpoints(provider)

    expect(result.ok).toBe(false)
    const message = (result as { message: string }).message
    expect(message).toMatch(/could not reach/i)
    expect(message).not.toMatch(/update the remote orca/i)
    expect(message).toContain('ECONNRESET')
  })

  it('does not call the probe more than once', async () => {
    const supported = vi.fn().mockResolvedValue(true)
    const provider = createMockProvider(supported)

    await assertRelaySupportsPipelineCheckpoints(provider)

    expect(supported).toHaveBeenCalledTimes(1)
  })
})
