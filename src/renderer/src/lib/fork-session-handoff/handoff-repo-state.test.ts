import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getRuntimeGitDiff } from '@/runtime/runtime-git-diff-client'
import { getRuntimeGitStatus } from '@/runtime/runtime-git-status-client'
import { runtimeTargetForWorkspaceOwner } from '@/lib/resolve-owner'
import type { HandoffTargetResolution } from './handoff-target-resolution'
import { fetchHandoffRepoState, formatHandoffStatusSummary } from './handoff-repo-state'

vi.mock('@/runtime/runtime-git-status-client', () => ({ getRuntimeGitStatus: vi.fn() }))
vi.mock('@/runtime/runtime-git-diff-client', () => ({ getRuntimeGitDiff: vi.fn() }))
vi.mock('@/lib/resolve-owner', () => ({
  runtimeTargetForWorkspaceOwner: vi.fn(() => ({ kind: 'local' }))
}))

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

const status = {
  branch: 'feature/handoff',
  conflictOperation: 'unknown' as const,
  entries: [
    { path: 'src/changed.ts', status: 'modified' as const, area: 'unstaged' as const },
    {
      path: 'src/renamed.ts',
      oldPath: 'src/old.ts',
      status: 'renamed' as const,
      area: 'staged' as const
    }
  ]
}

describe('fetchHandoffRepoState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getRuntimeGitStatus).mockResolvedValue(status)
    vi.mocked(runtimeTargetForWorkspaceOwner).mockReturnValue({ kind: 'local' })
    vi.mocked(getRuntimeGitDiff).mockResolvedValue({
      kind: 'text',
      originalContent: 'before',
      modifiedContent: 'after',
      originalIsBinary: false,
      modifiedIsBinary: false
    })
  })

  it('skips git entirely for folder workspaces', async () => {
    await expect(
      fetchHandoffRepoState({
        state: { settings: null },
        target: target({ isFolderWorkspace: true }),
        includeDiffBodies: true
      })
    ).resolves.toBeNull()
    expect(getRuntimeGitStatus).not.toHaveBeenCalled()
  })

  it('fetches status through the resolved SSH host and formats changed paths', async () => {
    const result = await fetchHandoffRepoState({
      state: {
        settings: null
      },
      target: target({ sshConnectionId: 'dev-box' }),
      includeDiffBodies: false
    })

    expect(getRuntimeGitStatus).toHaveBeenCalledWith(
      {
        target: { kind: 'local' },
        worktreeId: 'repo::/worktree',
        worktreePath: '/worktree',
        connectionId: 'dev-box'
      },
      { signal: undefined }
    )
    expect(result).toEqual({
      branch: 'feature/handoff',
      statusSummary:
        'unstaged: modified src/changed.ts\nstaged: renamed src/old.ts -> src/renamed.ts',
      changedPaths: ['src/changed.ts', 'src/renamed.ts'],
      diffBodies: null,
      diffTruncated: false
    })
  })

  it('routes git through the target workspace owner', async () => {
    vi.mocked(runtimeTargetForWorkspaceOwner).mockReturnValue({
      kind: 'environment',
      environmentId: 'target-env'
    })
    await fetchHandoffRepoState({
      state: {
        settings: null
      },
      target: target({ runtimeEnvironmentId: 'target-env' }),
      includeDiffBodies: false
    })

    expect(getRuntimeGitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: 'environment', environmentId: 'target-env' }
      }),
      expect.anything()
    )
  })

  it('fetches staged and unstaged bodies and enforces the global character cap', async () => {
    const result = await fetchHandoffRepoState({
      state: { settings: null },
      target: target(),
      includeDiffBodies: true,
      diffCharCap: 80
    })

    expect(result?.diffBodies?.length).toBe(80)
    expect(result?.diffTruncated).toBe(true)
  })
})

describe('formatHandoffStatusSummary', () => {
  it('reports a clean tree and a capped status listing', () => {
    expect(formatHandoffStatusSummary({ entries: [], conflictOperation: 'unknown' })).toBe(
      'Clean working tree.'
    )
    expect(
      formatHandoffStatusSummary({
        ...status,
        didHitLimit: true,
        statusLength: 4
      })
    ).toContain('... 2 additional changes omitted.')
  })
})
