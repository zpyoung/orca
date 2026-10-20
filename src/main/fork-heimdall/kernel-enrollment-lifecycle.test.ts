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

function existingEnrollment(): WatcherEnrollment {
  return {
    ...authorized(),
    watcherId: 'existing-1',
    enabled: false,
    paused: false,
    commandRevision: 0,
    coordinatorIdentity: { handle: 'coordinator', paneKey: 'pane-1' },
    orchestrationRunId: null,
    createdAtMs: 1,
    terminalAtMs: null
  }
}

function harness(
  options: {
    insert?: (enrollment: WatcherEnrollment) => WatcherEnrollment
    rollbackInserted?: EnrollmentStore['rollbackInserted']
    rearm?: () => WatcherEnrollment
    existing?: WatcherEnrollment
    validateEnrollment?: () => void
    validatePipelineSource?: KernelEnrollmentLifecycleDependencies['validatePipelineSource']
    afterInsert?: KernelEnrollmentLifecycleDependencies['afterInsert']
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
  const rollbackInserted = vi.fn(
    options.rollbackInserted ?? (() => ({ status: 'rolled-back' as const }))
  )
  const insert = vi.fn(options.insert ?? ((enrollment: WatcherEnrollment) => enrollment))
  const dependencies: KernelEnrollmentLifecycleDependencies = {
    registry,
    storageAuthority: 'desktop',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these lifecycle cases exercise only the store methods supplied here.
    enrollments: {
      findLiveByWorkspace: () => options.existing ?? null,
      insert,
      rollbackInserted,
      rearm: options.rearm ?? (() => ({ ...options.existing!, enabled: true }))
    } as unknown as EnrollmentStore,
    readLedger: vi.fn((watcherId: string) => ({ watcherId, entries: [] })),
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
    createId: () => 'id-1',
    ...(options.validatePipelineSource === undefined
      ? {}
      : { validatePipelineSource: options.validatePipelineSource }),
    ...(options.afterInsert === undefined ? {} : { afterInsert: options.afterInsert })
  }
  return { dependencies, insert, rollbackInserted, undo }
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
  it('runs pin recording only after a successful new insert', async () => {
    const afterInsert = vi.fn()
    const { dependencies, insert } = harness({ afterInsert })
    const enrollmentInput = input()

    await expect(enrollWatcher(enrollmentInput, dependencies)).resolves.toMatchObject({
      status: 'enrolled'
    })
    expect(insert).toHaveBeenCalledOnce()
    expect(afterInsert).toHaveBeenCalledWith(
      expect.objectContaining({ watcherId: 'id-1' }),
      enrollmentInput
    )
  })

  it('validates copied source before writing and preserves pins on re-arm', async () => {
    const afterInsert = vi.fn()
    const sourceRefusal = {
      status: 'refused',
      reason: 'invalid-payload',
      detail: 'source mismatch'
    } as const
    const validatePipelineSource = vi.fn<
      NonNullable<KernelEnrollmentLifecycleDependencies['validatePipelineSource']>
    >(() => sourceRefusal)
    const refusing = harness({ validatePipelineSource })

    await expect(enrollWatcher(input(), refusing.dependencies)).resolves.toEqual(sourceRefusal)
    expect(refusing.insert).not.toHaveBeenCalled()

    validatePipelineSource.mockImplementation(() => null)
    const existing = existingEnrollment()
    const rearming = harness({ existing, validatePipelineSource, afterInsert })
    await expect(enrollWatcher(input(), rearming.dependencies)).resolves.toMatchObject({
      status: 're-armed'
    })
    expect(rearming.insert).not.toHaveBeenCalled()
    expect(afterInsert).not.toHaveBeenCalled()
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

  it('rolls back an inserted enrollment when post-insert pin persistence fails', async () => {
    const failure = new Error('pipeline run-pin write failed')
    const { dependencies, rollbackInserted, undo } = harness({
      afterInsert: () => {
        throw failure
      }
    })

    await expect(enrollWatcher(input(), dependencies)).rejects.toBe(failure)
    expect(rollbackInserted).toHaveBeenCalledWith(expect.objectContaining({ watcherId: 'id-1' }))
    expect(undo).toHaveBeenCalledOnce()
    expect(dependencies.restore).not.toHaveBeenCalled()
    expect(dependencies.publish).not.toHaveBeenCalled()
  })

  it('preserves authorization side effects when the inserted row changed before rollback', async () => {
    const failure = new Error('pipeline run-pin write failed')
    const { dependencies, rollbackInserted, undo } = harness({
      afterInsert: () => {
        throw failure
      },
      rollbackInserted: () => ({
        status: 'refused',
        reason: 'row-changed',
        detail: 'Heimdall watcher id-1 changed after insertion'
      })
    })

    await expect(enrollWatcher(input(), dependencies)).rejects.toMatchObject({
      name: 'AggregateError',
      message: expect.stringContaining('could not be safely rolled back')
    })
    expect(rollbackInserted).toHaveBeenCalledOnce()
    expect(undo).not.toHaveBeenCalled()
    expect(dependencies.restore).not.toHaveBeenCalled()
    expect(dependencies.publish).not.toHaveBeenCalled()
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
