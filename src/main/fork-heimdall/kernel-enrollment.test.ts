import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { KernelAction, WatcherKind } from '../../shared/fork-heimdall/kind-contract'
import type { AuthorizedEnrollment, EnrollInput } from '../../shared/fork-heimdall/watcher-types'
import { authorizeKindEnrollment } from './kernel-enrollment'
import { WatcherKindRegistry } from './registry'

function authorized(overrides: Partial<AuthorizedEnrollment> = {}): AuthorizedEnrollment {
  return {
    kind: 'objective',
    workspaceKey: 'local::/worktree',
    executionHostId: 'local',
    repoId: 'repo-1',
    worktreeId: null,
    workspacePath: '/worktree',
    schedulerOwner: 'local_host_service',
    capabilities: { plan: 'on' },
    budget: { wallClockActiveMs: null, turns: null },
    kindPayload: {},
    ...overrides
  }
}

function fakeKind(
  authorizeEnrollment = vi.fn(async () => authorized())
): WatcherKind<unknown, KernelAction> {
  return {
    id: 'objective',
    displayName: 'objective',
    describeEnrollment: () => 'objective',
    enrollmentPayloadSchema: z.unknown(),
    authorizeEnrollment,
    read: vi.fn(),
    describeSnapshot: vi.fn(),
    decide: vi.fn(),
    execute: vi.fn(),
    resolveOutcome: vi.fn()
  }
}

function input(overrides: Partial<EnrollInput> = {}): EnrollInput {
  return {
    kind: 'objective',
    repoId: 'repo-1',
    worktreeId: null,
    capabilities: {},
    budget: { wallClockActiveMs: null, turns: null },
    kindPayload: {},
    ...overrides
  }
}

describe('authorizeKindEnrollment owner handling', () => {
  it('leaves capabilities and owner untouched when the candidate asks for no owner', async () => {
    const registry = new WatcherKindRegistry()
    registry.register(fakeKind())

    const result = await authorizeKindEnrollment(registry, input())

    expect(result.status).toBe('authorized')
    if (result.status !== 'authorized') {
      return
    }
    expect(result.authorized.owner).toBeUndefined()
    expect(result.authorized.capabilities).toEqual({ plan: 'on' })
  })

  it('refuses an unsupported owner agent before the kind ever authorizes', async () => {
    const registry = new WatcherKindRegistry()
    const authorizeEnrollment = vi.fn(async () => authorized())
    registry.register(fakeKind(authorizeEnrollment))

    const result = await authorizeKindEnrollment(registry, input({ owner: { agent: 'codex' } }))

    expect(result).toMatchObject({ status: 'refused', reason: 'invalid-payload' })
    expect(authorizeEnrollment).not.toHaveBeenCalled()
  })

  it('stamps a claude owner and the requested owner-intervention capability', async () => {
    const registry = new WatcherKindRegistry()
    registry.register(fakeKind())
    const owner = { agent: 'claude', model: 'opus', effort: 'high' }

    const result = await authorizeKindEnrollment(
      registry,
      input({ owner, ownerInterventionCapability: 'gated' })
    )

    expect(result.status).toBe('authorized')
    if (result.status !== 'authorized') {
      return
    }
    expect(result.authorized.owner).toEqual(owner)
    expect(result.authorized.capabilities).toEqual({ plan: 'on', 'owner-intervention': 'gated' })
  })

  it('keeps owner-intervention out of capabilities when the request does not set it', async () => {
    const registry = new WatcherKindRegistry()
    registry.register(fakeKind())

    const result = await authorizeKindEnrollment(registry, input({ owner: { agent: 'claude' } }))

    expect(result.status).toBe('authorized')
    if (result.status !== 'authorized') {
      return
    }
    expect(result.authorized.owner).toEqual({ agent: 'claude' })
    expect(Object.hasOwn(result.authorized.capabilities, 'owner-intervention')).toBe(false)
  })
})
