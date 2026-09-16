import { describe, expect, it, vi } from 'vitest'
import { deriveHandoffInput } from '../../shared/fork-heimdall-objective/objective-handoff-policy'
import { ObjectiveEnrollmentPayloadSchema } from '../../shared/fork-heimdall-objective/contract-types'
import {
  EnrollInputSchema,
  WatcherEnrollmentSchema,
  type EnrollInput
} from '../../shared/fork-heimdall/watcher-types'
import { authorizeKindEnrollment } from '../fork-heimdall/kernel-enrollment'
import { type RegisteredWatcherKind, WatcherKindRegistry } from '../fork-heimdall/registry'
import { enrollmentPayloadSchema } from '../fork-hosted-review-sitter/definition-store'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { authorizeObjectiveEnrollment, ObjectiveOwnerNotExecutableError } from './definition'
import { createObjectiveKind } from './kind'
import type { ObjectiveForgeAccess } from './objective-forge-access'
import type { ObjectiveStore } from './objective-store'

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

function forge(provider: 'github' | 'unsupported'): ObjectiveForgeAccess {
  return {
    detectProvider: vi.fn(async () => provider),
    getProvider: vi.fn(async () => null),
    getDefaultBranch: vi.fn(async () => null),
    isAuthenticated: vi.fn(async () => false),
    invalidate: vi.fn()
  }
}

async function authorizeThroughKernel(
  runtime: OrcaRuntimeService,
  repository: Store,
  enrollment: EnrollInput,
  objectiveForge: ObjectiveForgeAccess
) {
  const registry = new WatcherKindRegistry()
  registry.register(
    createObjectiveKind({
      runtime,
      store: repository,
      objectiveStore: {} as ObjectiveStore,
      forge: objectiveForge
    }) as unknown as RegisteredWatcherKind
  )
  return authorizeKindEnrollment(registry, enrollment)
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

  it('maps a hosted-review objective without an explicit worktree to invalid-payload', async () => {
    const enrollment = input({
      worktreeId: null,
      kindPayload: {
        ...(input().kindPayload as Record<string, unknown>),
        landingBar: 'hosted-review'
      }
    })

    await expect(
      authorizeThroughKernel(
        gitRuntime('local'),
        store({ id: 'repo-1' }),
        enrollment,
        forge('github')
      )
    ).resolves.toEqual({
      status: 'refused',
      reason: 'invalid-payload',
      detail: 'landing-bar-requires-worktree'
    })
  })

  it('maps an unsupported hosted-review forge to invalid-payload', async () => {
    const enrollment = input({
      kindPayload: {
        ...(input().kindPayload as Record<string, unknown>),
        landingBar: 'hosted-review'
      }
    })

    await expect(
      authorizeThroughKernel(
        gitRuntime('local'),
        store({ id: 'repo-1' }),
        enrollment,
        forge('unsupported')
      )
    ).resolves.toEqual({
      status: 'refused',
      reason: 'invalid-payload',
      detail: 'landing-bar-requires-supported-forge'
    })
  })

  it('derives a handoff accepted by both the kernel and hosted-review kind schemas', () => {
    const source = input()
    const contract = ObjectiveEnrollmentPayloadSchema.parse({
      ...(source.kindPayload as Record<string, unknown>),
      landingBar: 'hosted-review'
    })
    const enrollment = WatcherEnrollmentSchema.parse({
      watcherId: 'objective-watcher',
      kind: 'objective',
      workspaceKey: 'local::/workspace/repo',
      executionHostId: 'local',
      repoId: source.repoId,
      worktreeId: source.worktreeId,
      workspacePath: '/workspace/repo',
      schedulerOwner: 'local_host_service',
      enabled: true,
      paused: false,
      commandRevision: 0,
      capabilities: source.capabilities,
      budget: source.budget,
      kindPayload: contract,
      coordinatorIdentity: { handle: 'coordinator-handle', paneKey: 'coordinator-pane' },
      orchestrationRunId: null,
      createdAtMs: 1,
      terminalAtMs: null
    })
    const handoff = deriveHandoffInput({
      enrollment,
      contract,
      landing: {
        revisionId: 'revision-1',
        fromContentIdentity: 'content-before-review',
        provider: 'github',
        reviewNumber: 42,
        reviewUrl: 'https://github.test/acme/repo/pull/42',
        branch: 'feature/objective',
        headSha: 'a'.repeat(40),
        base: 'main'
      },
      budgetState: { activeMs: 5_000, turns: 2, exhausted: null }
    })

    expect(EnrollInputSchema.parse(handoff)).toEqual(handoff)
    expect(enrollmentPayloadSchema.parse(handoff.kindPayload)).toEqual(handoff.kindPayload)
  })
})
