import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandoffTargetResolution } from './handoff-target-resolution'
import { resolveTranscriptReachability } from './handoff-transcript-reachability'

const pathExists = vi.fn()
const resolveTranscript = vi.fn()

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

function probe(overrides: Record<string, unknown> = {}) {
  return {
    agent: 'claude',
    sessionId: 'session-1',
    transcriptPath: '/home/ada/.claude/projects/repo/session-1.jsonl',
    paneKey: 'tab-1:leaf-1',
    workspacePath: '/workspace/repo',
    sourceExecutionHostId: 'local',
    target: target(),
    ...overrides
  } as Parameters<typeof resolveTranscriptReachability>[0]
}

describe('resolveTranscriptReachability', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', {
      api: { fs: { pathExists }, forkSessionHandoff: { resolveTranscript } }
    })
  })

  it('returns none without a transcript path or session id', async () => {
    await expect(
      resolveTranscriptReachability(probe({ transcriptPath: '  ', sessionId: null }))
    ).resolves.toEqual({ verdict: 'none', transcriptPath: null })
    expect(resolveTranscript).not.toHaveBeenCalled()
    expect(pathExists).not.toHaveBeenCalled()
  })

  // Why this is not fs.pathExists: transcripts live outside every repo, and that
  // channel's local branch denies any path outside the workspace allow-list.
  it('resolves local transcripts through the agent-scoped probe', async () => {
    resolveTranscript.mockResolvedValue({
      outcome: 'found',
      transcriptPath: '/home/ada/.claude/projects/repo/session-1.jsonl'
    })
    await expect(resolveTranscriptReachability(probe())).resolves.toEqual({
      verdict: 'usable',
      transcriptPath: '/home/ada/.claude/projects/repo/session-1.jsonl'
    })
    expect(resolveTranscript).toHaveBeenCalledWith({
      agent: 'claude',
      sessionId: 'session-1',
      transcriptPath: '/home/ada/.claude/projects/repo/session-1.jsonl',
      paneKey: 'tab-1:leaf-1',
      workspacePath: '/workspace/repo',
      connectionId: null
    })
    expect(pathExists).not.toHaveBeenCalled()
  })

  it('reports the path the host resolved, not the one the hook reported', async () => {
    resolveTranscript.mockResolvedValue({
      outcome: 'found',
      transcriptPath: '/home/ada/.claude/projects/repo/renamed.jsonl'
    })
    await expect(resolveTranscriptReachability(probe())).resolves.toEqual({
      verdict: 'usable',
      transcriptPath: '/home/ada/.claude/projects/repo/renamed.jsonl'
    })
  })

  // An SSH target runs the same candidate chain, on the connection that owns the
  // transcript disk — fs.pathExists there would check only the reported path and
  // never recover a rotated session id.
  it('routes same-connection SSH transcripts through the agent-scoped probe', async () => {
    resolveTranscript.mockResolvedValue({
      outcome: 'found',
      transcriptPath: '/home/ada/.claude/projects/repo/recovered.jsonl',
      provenance: 'project-scan'
    })
    await expect(
      resolveTranscriptReachability(
        probe({
          sourceExecutionHostId: 'ssh:dev-box',
          target: target({ sshConnectionId: 'dev-box' })
        })
      )
    ).resolves.toEqual({
      verdict: 'usable',
      transcriptPath: '/home/ada/.claude/projects/repo/recovered.jsonl'
    })
    expect(resolveTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'dev-box' })
    )
    expect(pathExists).not.toHaveBeenCalled()
  })

  it('rejects host changes before probing a path', async () => {
    await expect(
      resolveTranscriptReachability(
        probe({
          sourceExecutionHostId: 'ssh:other-box',
          target: target({ sshConnectionId: 'dev-box' })
        })
      )
    ).resolves.toEqual({ verdict: 'unreachable', transcriptPath: null })
    expect(pathExists).not.toHaveBeenCalled()
    expect(resolveTranscript).not.toHaveBeenCalled()
  })

  it('treats runtime targets as unreachable even on the same runtime', async () => {
    await expect(
      resolveTranscriptReachability(
        probe({
          sourceExecutionHostId: 'runtime:env-1',
          target: target({ runtimeEnvironmentId: 'env-1' })
        })
      )
    ).resolves.toEqual({ verdict: 'unreachable', transcriptPath: null })
    expect(resolveTranscript).not.toHaveBeenCalled()
  })

  it('reports an absent transcript as unreachable', async () => {
    resolveTranscript.mockResolvedValue({ outcome: 'missing' })
    await expect(resolveTranscriptReachability(probe())).resolves.toEqual({
      verdict: 'unreachable',
      transcriptPath: null
    })
  })

  // "Could not decide" must not reach the user as "not on this target": the
  // dialog wording differs, and only this verdict keeps them apart.
  it('keeps an undecided probe distinct from an absent transcript', async () => {
    for (const reason of ['stat-failed', 'host-unavailable', 'ambiguous-project-scan']) {
      resolveTranscript.mockResolvedValueOnce({ outcome: 'unverifiable', reason })
      await expect(resolveTranscriptReachability(probe())).resolves.toEqual({
        verdict: 'unverifiable',
        transcriptPath: null
      })
    }
  })

  it('treats a rejected probe as undecided, not as an absent transcript', async () => {
    resolveTranscript.mockRejectedValue(new Error('offline'))
    await expect(resolveTranscriptReachability(probe())).resolves.toEqual({
      verdict: 'unverifiable',
      transcriptPath: null
    })
  })

  // A session that never reported a transcript has nothing to warn about.
  it('reports none when a session-id-only probe finds nothing', async () => {
    resolveTranscript.mockResolvedValue({ outcome: 'missing' })
    await expect(resolveTranscriptReachability(probe({ transcriptPath: null }))).resolves.toEqual({
      verdict: 'none',
      transcriptPath: null
    })
  })
})
