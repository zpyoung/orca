import { describe, expect, it, vi } from 'vitest'
import type { EnrollInput } from '../../shared/fork-heimdall/watcher-types'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { authorizeObjectiveEnrollment, ObjectiveOwnerNotExecutableError } from './definition'

function input(overrides: Partial<EnrollInput> = {}): EnrollInput {
  return {
    kind: 'objective',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    capabilities: {
      plan: 'on',
      implement: 'on',
      review: 'on',
      check: 'on',
      land: 'on'
    },
    budget: { wallClockActiveMs: 60_000, turns: 12 },
    kindPayload: {
      objectiveText: 'Implement the objective safely.',
      tier: 'standard',
      landingBar: 'files-on-disk',
      maxConcurrency: 1,
      workspaceKind: 'git',
      writeTerritory: ['src/**'],
      roleAgents: { planner: 'codex' },
      sitterOverrides: {}
    },
    ...overrides
  }
}

function store(repo: Record<string, unknown>): Store {
  return { getRepo: () => repo } as unknown as Store
}

function gitRuntime(executionHostId: 'local' | `ssh:${string}` | `runtime:${string}`) {
  return {
    resolveRuntimeGitTarget: async () => ({
      executionHostId,
      worktree: {
        id: 'worktree-1',
        repoId: 'repo-1',
        path: '/workspace/repo',
        git: { isBare: false, prunable: false }
      }
    })
  } as unknown as OrcaRuntimeService
}

describe('objective enrollment authorization', () => {
  it('re-derives an SSH execution host and scheduler owner instead of trusting renderer paths', async () => {
    const authorized = await authorizeObjectiveEnrollment(
      gitRuntime('ssh:build-host'),
      store({ id: 'repo-1', executionHostId: 'local' }),
      input()
    )

    expect(authorized.executionHostId).toBe('ssh:build-host')
    expect(authorized.workspacePath).toBe('/workspace/repo')
    expect(authorized.workspaceKey).toBe('ssh:build-host::/workspace/repo')
    expect(authorized.schedulerOwner).toBe('ssh_bridge')
  })

  it('refuses an objective owned by another runtime before persisting it locally', async () => {
    await expect(
      authorizeObjectiveEnrollment(
        gitRuntime('runtime:other-host'),
        store({ id: 'repo-1' }),
        input()
      )
    ).rejects.toBeInstanceOf(ObjectiveOwnerNotExecutableError)
  })

  it('refuses landing bars above files-on-disk for folder workspaces', async () => {
    const runtime = {
      resolveRuntimeFileTarget: async () => ({
        executionHostId: 'local',
        worktree: { repoId: 'repo-1', path: '/workspace/folder' }
      })
    } as unknown as OrcaRuntimeService
    const enrollment = input({
      worktreeId: null,
      kindPayload: {
        ...(input().kindPayload as Record<string, unknown>),
        landingBar: 'merged',
        workspaceKind: 'folder'
      }
    })

    await expect(
      authorizeObjectiveEnrollment(runtime, store({ id: 'repo-1', kind: 'folder' }), enrollment)
    ).rejects.toThrow('landing-bar-requires-git')
  })

  it('resolves a folder objective through the repository root target on its owning host', async () => {
    const resolveRuntimeFileTarget = vi.fn(async () => ({
      executionHostId: 'ssh:folder-host' as const,
      worktree: { repoId: 'repo-1', path: '/workspace/folder' }
    }))
    const runtime = { resolveRuntimeFileTarget } as unknown as OrcaRuntimeService
    const enrollment = input({
      worktreeId: null,
      kindPayload: {
        ...(input().kindPayload as Record<string, unknown>),
        workspaceKind: 'folder'
      }
    })

    const authorized = await authorizeObjectiveEnrollment(
      runtime,
      store({
        id: 'repo-1',
        kind: 'folder',
        path: '/workspace/folder',
        executionHostId: 'ssh:folder-host'
      }),
      enrollment
    )

    expect(resolveRuntimeFileTarget).toHaveBeenCalledWith('id:repo-1::/workspace/folder')
    expect(authorized.executionHostId).toBe('ssh:folder-host')
    expect(authorized.workspacePath).toBe('/workspace/folder')
  })

  it('refuses unsupported multi-worker concurrency at the authorization boundary', async () => {
    const enrollment = input({
      kindPayload: {
        ...(input().kindPayload as Record<string, unknown>),
        maxConcurrency: 2
      }
    })

    await expect(
      authorizeObjectiveEnrollment(gitRuntime('local'), store({ id: 'repo-1' }), enrollment)
    ).rejects.toThrow('max-concurrency-unsupported')
  })
})
