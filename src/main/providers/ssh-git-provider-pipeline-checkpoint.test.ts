import { describe, expect, it, vi, beforeEach } from 'vitest'
import { SshGitProvider } from './ssh-git-provider'

type MockMultiplexer = {
  request: ReturnType<typeof vi.fn>
  notify: ReturnType<typeof vi.fn>
  onNotification: ReturnType<typeof vi.fn>
  onNotificationByMethod: ReturnType<typeof vi.fn>
  onDispose: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  isDisposed: ReturnType<typeof vi.fn>
}

function createMockMux(): MockMultiplexer {
  return {
    request: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn(),
    onNotification: vi.fn(),
    onNotificationByMethod: vi.fn().mockReturnValue(vi.fn()),
    onDispose: vi.fn().mockReturnValue(vi.fn()),
    dispose: vi.fn(),
    isDisposed: vi.fn().mockReturnValue(false)
  }
}

function methodNotFoundError(method: string): Error & { code: number } {
  return Object.assign(new Error(`Method not found: ${method}`), { code: -32601 })
}

describe('SshGitProvider pipeline checkpoint RPCs', () => {
  let mux: MockMultiplexer
  let provider: SshGitProvider

  beforeEach(() => {
    mux = createMockMux()
    provider = new SshGitProvider('conn-1', mux as never)
  })

  it('pipelineCheckpointSupported sends the probe request and reports true', async () => {
    mux.request.mockResolvedValueOnce({ supported: true })

    await expect(provider.pipelineCheckpointSupported()).resolves.toBe(true)
    expect(mux.request).toHaveBeenCalledWith('git.pipelineCheckpointSupported', {})
  })

  it('pipelineCheckpointSupported maps method-not-found to false', async () => {
    mux.request.mockRejectedValueOnce(methodNotFoundError('git.pipelineCheckpointSupported'))

    await expect(provider.pipelineCheckpointSupported()).resolves.toBe(false)
  })

  it('pipelineCheckpointSupported rethrows non-method-not-found errors', async () => {
    const transportError = new Error('connection reset')
    mux.request.mockRejectedValueOnce(transportError)

    await expect(provider.pipelineCheckpointSupported()).rejects.toBe(transportError)
  })

  it('pipelineCheckpointCapture sends the capture request and returns the result', async () => {
    mux.request.mockResolvedValueOnce({
      head: 'a'.repeat(40),
      snapshot: 'b'.repeat(40),
      ref: 'refs/orca/pipeline/run_1/node-1-1'
    })

    const result = await provider.pipelineCheckpointCapture({
      worktreePath: '/home/user/feat',
      runId: 'run_1',
      nodeId: 'node-1',
      attempt: 1
    })

    expect(mux.request).toHaveBeenCalledWith('git.pipelineCheckpointCapture', {
      worktreePath: '/home/user/feat',
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

  it('pipelineCheckpointRestore sends the restore request', async () => {
    mux.request.mockResolvedValueOnce({ restored: true })

    await provider.pipelineCheckpointRestore({
      worktreePath: '/home/user/feat',
      head: 'a'.repeat(40),
      snapshot: 'b'.repeat(40)
    })

    expect(mux.request).toHaveBeenCalledWith('git.pipelineCheckpointRestore', {
      worktreePath: '/home/user/feat',
      head: 'a'.repeat(40),
      snapshot: 'b'.repeat(40)
    })
  })
})
