import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandoffTargetResolution } from './handoff-target-resolution'
import { resolveTranscriptReachability } from './handoff-transcript-reachability'

const pathExists = vi.fn()

function target(overrides: Partial<HandoffTargetResolution> = {}): HandoffTargetResolution {
  return {
    worktreeId: 'repo::/worktree',
    workspacePath: '/worktree',
    initialCwd: '/worktree',
    sshConnectionId: null,
    runtimeEnvironmentId: null,
    isFolderWorkspace: false,
    ...overrides
  }
}

describe('resolveTranscriptReachability', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', { api: { fs: { pathExists } } })
  })

  it('returns none without a transcript path', async () => {
    await expect(
      resolveTranscriptReachability({
        transcriptPath: '  ',
        sourceExecutionHostId: 'local',
        target: target()
      })
    ).resolves.toBe('none')
    expect(pathExists).not.toHaveBeenCalled()
  })

  it('validates local transcripts on the local filesystem', async () => {
    pathExists.mockResolvedValue(true)
    await expect(
      resolveTranscriptReachability({
        transcriptPath: '/home/ada/session.jsonl',
        sourceExecutionHostId: 'local',
        target: target()
      })
    ).resolves.toBe('usable')
    expect(pathExists).toHaveBeenCalledWith({ filePath: '/home/ada/session.jsonl' })
  })

  it('validates same-connection SSH transcripts through that connection', async () => {
    pathExists.mockResolvedValue(true)
    await expect(
      resolveTranscriptReachability({
        transcriptPath: '/home/ada/session.jsonl',
        sourceExecutionHostId: 'ssh:dev-box',
        target: target({ sshConnectionId: 'dev-box' })
      })
    ).resolves.toBe('usable')
    expect(pathExists).toHaveBeenCalledWith({
      filePath: '/home/ada/session.jsonl',
      connectionId: 'dev-box'
    })
  })

  it('rejects host changes before probing a path', async () => {
    await expect(
      resolveTranscriptReachability({
        transcriptPath: '/home/ada/session.jsonl',
        sourceExecutionHostId: 'ssh:other-box',
        target: target({ sshConnectionId: 'dev-box' })
      })
    ).resolves.toBe('unreachable')
    expect(pathExists).not.toHaveBeenCalled()
  })

  it('treats runtime targets as unreachable even on the same runtime', async () => {
    await expect(
      resolveTranscriptReachability({
        transcriptPath: '/home/ada/session.jsonl',
        sourceExecutionHostId: 'runtime:env-1',
        target: target({ runtimeEnvironmentId: 'env-1' })
      })
    ).resolves.toBe('unreachable')
    expect(pathExists).not.toHaveBeenCalled()
  })

  it('downgrades missing paths and filesystem failures', async () => {
    pathExists.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('offline'))
    const args = {
      transcriptPath: '/home/ada/session.jsonl',
      sourceExecutionHostId: 'local',
      target: target()
    }
    await expect(resolveTranscriptReachability(args)).resolves.toBe('unreachable')
    await expect(resolveTranscriptReachability(args)).resolves.toBe('unreachable')
  })
})
