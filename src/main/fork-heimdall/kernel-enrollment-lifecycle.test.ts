import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { EnrollmentAuthorizationScope } from '../../shared/fork-heimdall/kind-contract'
import type {
  AuthorizedEnrollment,
  EnrollInput,
  WatcherEnrollment
} from '../../shared/fork-heimdall/watcher-types'
import type { EnrollmentStore } from './enrollment-store'
import {
  enrollWatcher,
  type KernelEnrollmentLifecycleDependencies
} from './kernel-enrollment-lifecycle'
import { type RegisteredWatcherKind, WatcherKindRegistry } from './registry'
import type { WatcherRunner } from './runner-state'

function authorized(): AuthorizedEnrollment {
  return {
    kind: 'objective',
    workspaceKey: 'local::/worktree',
    executionHostId: 'local',
    repoId: 'repo-1',
    worktreeId: 'created-1',
    workspacePath: '/worktree',
    schedulerOwner: 'local_host_service',
    capabilities: { plan: 'on' },
    budget: { wallClockActiveMs: null, turns: null },
    kindPayload: {}
  }
}

function input(): EnrollInput {
  return {
    kind: 'objective',
    repoId: 'repo-1',
    worktreeId: null,
    capabilities: {},
    budget: { wallClockActiveMs: null, turns: null },
    kindPayload: {}
  }
}

function harness(
  options: {
    insert?: (enrollment: WatcherEnrollment) => WatcherEnrollment
    validateEnrollment?: () => void
    restore?: () => WatcherRunner
  } = {}
) {
  const undo = vi.fn(async () => {})
  const registry = new WatcherKindRegistry()
  const kind: RegisteredWatcherKind = {
    id: 'objective',
    displayName: 'objective',
    describeEnrollment: () => 'objective',
    enrollmentPayloadSchema: z.unknown(),
    authorizeEnrollment: async (_input: EnrollInput, scope?: EnrollmentAuthorizationScope) => {
      scope?.onAbandoned(undo)
      return authorized()
    },
    ...(options.validateEnrollment ? { validateEnrollment: options.validateEnrollment } : {}),
    read: vi.fn(),
    describeSnapshot: vi.fn(),
    decide: vi.fn(),
    execute: vi.fn(),
    resolveOutcome: vi.fn()
  }
  registry.register(kind)
  const insert = vi.fn(options.insert ?? ((enrollment: WatcherEnrollment) => enrollment))
  const dependencies: KernelEnrollmentLifecycleDependencies = {
    registry,
    storageAuthority: 'desktop',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a first enrollment only reads findLiveByWorkspace and writes insert.
    enrollments: {
      findLiveByWorkspace: () => null,
      insert
    } as unknown as EnrollmentStore,
    readLedger: vi.fn(),
    appendBudgetGeneration: vi.fn(),
    owns: () => true,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the enrolled result never reads the restored runner.
    restore: vi.fn(options.restore ?? (() => ({}) as WatcherRunner)),
    runner: () => null,
    acknowledgePark: vi.fn(),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the list entry is echoed into the result and never inspected here.
    entry: vi.fn(() => ({}) as ReturnType<KernelEnrollmentLifecycleDependencies['entry']>),
    schedule: vi.fn(),
    publish: vi.fn(),
    now: () => 1,
    createId: () => 'id-1'
  }
  return { dependencies, insert, undo }
}

describe('enrollWatcher authorization undo', () => {
  it('keeps authorization side effects once the enrollment is inserted', async () => {
    const { dependencies, insert, undo } = harness()

    await expect(enrollWatcher(input(), dependencies)).resolves.toMatchObject({
      status: 'enrolled'
    })
    expect(insert).toHaveBeenCalledOnce()
    expect(undo).not.toHaveBeenCalled()
  })

  it('undoes authorization side effects when the insert fails', async () => {
    const failure = new Error('attempt to write a readonly database')
    const { dependencies, undo } = harness({
      insert: () => {
        throw failure
      }
    })

    await expect(enrollWatcher(input(), dependencies)).rejects.toBe(failure)
    expect(undo).toHaveBeenCalledOnce()
  })

  it('undoes authorization side effects when kind validation refuses', async () => {
    const { dependencies, insert, undo } = harness({
      validateEnrollment: () => {
        throw new Error('plan-off-requires-approved-plan')
      }
    })

    await expect(enrollWatcher(input(), dependencies)).resolves.toMatchObject({
      status: 'refused',
      detail: 'plan-off-requires-approved-plan'
    })
    expect(insert).not.toHaveBeenCalled()
    expect(undo).toHaveBeenCalledOnce()
  })

  it('does not undo a persisted enrollment when activation fails afterwards', async () => {
    const failure = new Error('runner restore failed')
    const { dependencies, undo } = harness({
      restore: () => {
        throw failure
      }
    })

    await expect(enrollWatcher(input(), dependencies)).rejects.toBe(failure)
    expect(undo).not.toHaveBeenCalled()
  })

  it('does not let a failing undo mask the enrollment failure', async () => {
    const failure = new Error('attempt to write a readonly database')
    const { dependencies, undo } = harness({
      insert: () => {
        throw failure
      }
    })
    undo.mockRejectedValueOnce(new Error('removal unavailable'))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(enrollWatcher(input(), dependencies)).rejects.toBe(failure)
      expect(warning).toHaveBeenCalledWith(
        'Heimdall enrollment authorization undo failed',
        expect.any(Error)
      )
    } finally {
      warning.mockRestore()
    }
  })
})
