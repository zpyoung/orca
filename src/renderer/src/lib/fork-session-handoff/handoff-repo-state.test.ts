import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getRuntimeGitDiff, getRuntimeGitStatus } from '@/runtime/runtime-git-client'
import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import type { HandoffTargetResolution } from './handoff-target-resolution'
import { fetchHandoffRepoState, formatHandoffStatusSummary } from './handoff-repo-state'

vi.mock('@/runtime/runtime-git-client', () => ({
  getRuntimeGitStatus: vi.fn(),
  getRuntimeGitDiff: vi.fn()
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getSettingsForWorktreeRuntimeOwner: vi.fn(() => ({ activeRuntimeEnvironmentId: null }))
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
    vi.mocked(getSettingsForWorktreeRuntimeOwner).mockReturnValue({
      activeRuntimeEnvironmentId: null
    })
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
        settings: { activeRuntimeEnvironmentId: 'stale-env' } as never
      },
      target: target({ sshConnectionId: 'dev-box' }),
      includeDiffBodies: false
    })

    expect(getRuntimeGitStatus).toHaveBeenCalledWith(
      {
        settings: expect.objectContaining({ activeRuntimeEnvironmentId: null }),
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

  it('selects owner settings through the target worktree runtime helper', async () => {
    vi.mocked(getSettingsForWorktreeRuntimeOwner).mockReturnValue({
      activeRuntimeEnvironmentId: 'target-env'
    })
    await fetchHandoffRepoState({
      state: {
        settings: { activeRuntimeEnvironmentId: 'old-env' } as never
      },
      target: target({ runtimeEnvironmentId: 'target-env' }),
      includeDiffBodies: false
    })

    expect(getRuntimeGitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ activeRuntimeEnvironmentId: 'target-env' })
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

    expect(getRuntimeGitDiff).toHaveBeenNthCalledWith(1, expect.anything(), {
      filePath: 'src/changed.ts',
      staged: false
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
