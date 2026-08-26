import { describe, expect, it, vi } from 'vitest'
import { getConnectionIdFromState } from '@/lib/connection-owner-resolution'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  createHandoffAgentDetectionGeneration,
  getHandoffAnchorRepoId,
  listHandoffTargetCandidates,
  resolveHandoffHostChange,
  resolveHandoffTarget,
  resolveHandoffTargetExecutionHostId
} from './handoff-target-resolution'

vi.mock('@/lib/connection-owner-resolution', () => ({
  getConnectionIdFromState: vi.fn(() => null)
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: vi.fn(() => null)
}))

type TargetState = Parameters<typeof listHandoffTargetCandidates>[0]

function makeState(): TargetState {
  return {
    activeWorkspaceExecutionHostId: null,
    activeWorkspaceKey: null,
    activeWorktreeId: null,
    detectedWorktreesByRepo: {},
    folderWorkspaces: [
      {
        id: 'folder-1',
        projectGroupId: 'group-1',
        name: 'Platform folder',
        folderPath: '/repo'
      }
    ],
    projectGroups: [{ id: 'group-1' }],
    repos: [{ id: 'repo-1', path: '/repo', displayName: 'Repo', kind: 'git' }],
    restoredRuntimeHostIdByWorkspaceSessionKey: {},
    settings: null,
    worktreesByRepo: {
      'repo-1': [
        {
          id: 'repo-1::/repo',
          repoId: 'repo-1',
          displayName: 'Main',
          path: '/repo'
        },
        {
          id: 'repo-1::/repo/feature',
          repoId: 'repo-1',
          displayName: 'Feature',
          path: '/repo/feature'
        }
      ]
    }
  } as unknown as TargetState
}

describe('handoff target candidates', () => {
  it('lists the anchor repo worktrees and applicable folder workspaces', () => {
    expect(listHandoffTargetCandidates(makeState(), 'repo-1::/repo')).toEqual([
      {
        worktreeId: 'repo-1::/repo',
        displayName: 'Main',
        workspacePath: '/repo',
        isFolderWorkspace: false
      },
      {
        worktreeId: 'repo-1::/repo/feature',
        displayName: 'Feature',
        workspacePath: '/repo/feature',
        isFolderWorkspace: false
      },
      {
        worktreeId: folderWorkspaceKey('folder-1'),
        displayName: 'Platform folder',
        workspacePath: '/repo',
        isFolderWorkspace: true
      }
    ])
  })

  it('allows inline creation only from a git worktree anchor', () => {
    const state = makeState()
    expect(getHandoffAnchorRepoId(state, 'repo-1::/repo')).toBe('repo-1')
    expect(getHandoffAnchorRepoId(state, folderWorkspaceKey('folder-1'))).toBeNull()
  })
})

describe('handoff target host resolution', () => {
  it('resolves local, SSH, runtime, and folder targets through upstream owner functions', () => {
    vi.mocked(getConnectionIdFromState).mockImplementation((_state, worktreeId) =>
      worktreeId?.includes('feature') ? 'dev-box' : null
    )
    vi.mocked(getRuntimeEnvironmentIdForWorktree).mockImplementation((_state, worktreeId) =>
      worktreeId?.includes('/repo') && !worktreeId.includes('feature') ? 'env-1' : null
    )
    const state = makeState()
    const runtime = resolveHandoffTarget(state, 'repo-1::/repo')
    const ssh = resolveHandoffTarget(state, 'repo-1::/repo/feature')
    const folder = resolveHandoffTarget(state, folderWorkspaceKey('folder-1'))

    expect(runtime).toMatchObject({ runtimeEnvironmentId: 'env-1', sshConnectionId: null })
    expect(ssh).toMatchObject({ runtimeEnvironmentId: null, sshConnectionId: 'dev-box' })
    expect(folder).toMatchObject({
      workspacePath: '/repo',
      initialCwd: '/repo',
      isFolderWorkspace: true
    })
    expect(resolveHandoffTargetExecutionHostId(runtime!)).toBe('runtime:env-1')
    expect(resolveHandoffTargetExecutionHostId(ssh!)).toBe('ssh:dev-box')
  })

  it('rejects an unresolved mixed-host route', () => {
    vi.mocked(getConnectionIdFromState).mockReturnValue(undefined)
    expect(resolveHandoffTarget(makeState(), 'repo-1::/repo')).toBeNull()
  })

  it('reports known host changes and treats an unknown source as local only', () => {
    const target = {
      worktreeId: 'repo-1::/repo',
      workspacePath: '/repo',
      initialCwd: '/repo',
      sshConnectionId: 'dev-box',
      runtimeEnvironmentId: null,
      isFolderWorkspace: false
    }
    expect(resolveHandoffHostChange('ssh:dev-box', target)).toBe(false)
    expect(resolveHandoffHostChange('local', target)).toBe(true)
    expect(resolveHandoffHostChange(null, target)).toBe(true)
    expect(resolveHandoffHostChange(null, { ...target, sshConnectionId: null })).toBe(false)
  })
})

describe('handoff target agent detection generation', () => {
  it('discards a stale completion and preserves only a surviving selection', async () => {
    const completions = new Map<string, (agents: TuiAgent[]) => void>()
    const detect = vi.fn(
      (worktreeId: string) =>
        new Promise<TuiAgent[]>((resolve) => completions.set(worktreeId, resolve))
    )
    const generation = createHandoffAgentDetectionGeneration(detect)
    const first = generation.detect('first', 'claude')
    const second = generation.detect('second', 'codex')

    completions.get('first')?.(['claude'])
    completions.get('second')?.(['claude', 'codex'])

    await expect(first).resolves.toBeNull()
    await expect(second).resolves.toEqual({
      agents: ['claude', 'codex'],
      selectedAgent: 'codex'
    })
  })

  it('clears a selection that is missing after re-detection', async () => {
    const generation = createHandoffAgentDetectionGeneration(async () => ['claude'])
    await expect(generation.detect('target', 'codex')).resolves.toEqual({
      agents: ['claude'],
      selectedAgent: null
    })
  })
})
