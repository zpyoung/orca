import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { KernelAction, WatcherKind } from '../../shared/fork-heimdall/kind-contract'
import type { EnrollInput } from '../../shared/fork-heimdall/watcher-types'
import {
  authorized,
  harness,
  input,
  watcherKind,
  type World
} from './kernel-lifecycle-test-harness'

vi.mock('electron', () => ({}))

const objectiveInput: EnrollInput = {
  ...input,
  kind: 'objective',
  kindPayload: { label: 'Objective' }
}

const sitterInput: EnrollInput = {
  ...input,
  kindPayload: { label: 'Sitter', reviewUrl: 'https://example.test/review/1' }
}

function handoffObjective(
  derive = vi.fn(async () => ({
    kind: 'enroll' as const,
    input: sitterInput,
    reason: 'bar-reached'
  }))
) {
  return watcherKind({
    id: 'objective',
    authorizeEnrollment: async (enrollment) => authorized(enrollment),
    handoff: { derive },
    stopPredicates: [
      {
        id: 'objective-bar-reached',
        disposition: 'terminal',
        evaluate: () => ({
          stop: true,
          reason: 'hosted-review rung reached; handed off',
          detail: 'revision-1'
        })
      }
    ]
  })
}

function handoffSitter(
  overrides: Partial<WatcherKind<World, KernelAction, { label: string }>> = {}
) {
  return watcherKind({
    enrollmentPayloadSchema: z.object({ label: z.string(), reviewUrl: z.string().url() }).strict(),
    ...overrides
  })
}

describe('Heimdall atomic terminal handoff', () => {
  it('commits both ledgers and the sitter enrollment once before activation', async () => {
    const derive = vi.fn(async () => ({
      kind: 'enroll' as const,
      input: sitterInput,
      reason: 'bar-reached'
    }))
    const world = await harness()
    world.service.registerKind(handoffSitter())
    world.service.registerKind(handoffObjective(derive))
    const enrolled = await world.service.enroll(objectiveInput)
    if (enrolled.status !== 'enrolled') {
      throw new Error('Expected objective enrollment')
    }
    const objectiveId = enrolled.entry.enrollment.watcherId

    await world.service.reconcileForTesting(objectiveId)

    const records = world.enrollmentStore.list()
    const sitter = records.find((record) => record.kind === 'hosted-review')
    expect(records).toHaveLength(2)
    expect(world.enrollmentStore.get(objectiveId)).toMatchObject({
      enabled: false,
      terminalAtMs: 100
    })
    expect(sitter).toMatchObject({ enabled: true, terminalAtMs: null, createdAtMs: 100 })
    if (!sitter) {
      throw new Error('Expected sitter enrollment')
    }
    expect(world.service.ledger(objectiveId).entries).toEqual([
      expect.objectContaining({ kind: 'terminal' })
    ])
    expect(world.service.ledger(sitter.watcherId).entries[0]).toMatchObject({
      kind: 'evidence',
      evidenceKind: 'handoff-origin',
      payload: {
        objectiveWatcherId: objectiveId,
        contentIdentity: 'revision-1',
        reachedRung: 'hosted-review'
      }
    })

    await world.service.reconcileForTesting(objectiveId)
    expect(derive).toHaveBeenCalledTimes(1)
    expect(
      world.enrollmentStore.list().filter((record) => record.kind === 'hosted-review')
    ).toHaveLength(1)
    await world.service.stopForShutdown()
  })

  it('terminates without a sitter when sitter authorization is refused', async () => {
    const world = await harness()
    world.service.registerKind(
      handoffSitter({
        authorizeEnrollment: async () => {
          throw new Error('review closed')
        }
      })
    )
    world.service.registerKind(handoffObjective())
    const enrolled = await world.service.enroll(objectiveInput)
    if (enrolled.status !== 'enrolled') {
      throw new Error('Expected objective enrollment')
    }
    const objectiveId = enrolled.entry.enrollment.watcherId

    await world.service.reconcileForTesting(objectiveId)

    expect(world.enrollmentStore.list()).toHaveLength(1)
    expect(world.enrollmentStore.get(objectiveId)?.terminalAtMs).toBe(100)
    expect(world.service.ledger(objectiveId).entries).toEqual([
      expect.objectContaining({ kind: 'terminal' })
    ])
    await world.service.stopForShutdown()
  })

  it('refuses a sitter authorization that moves the handoff to another workspace', async () => {
    const world = await harness()
    world.service.registerKind(
      handoffSitter({
        authorizeEnrollment: async (enrollment) => ({
          ...authorized(enrollment),
          workspaceKey: 'runtime:other-host::/workspace/moved' as const,
          executionHostId: 'runtime:other-host' as const,
          workspacePath: '/workspace/moved'
        })
      })
    )
    world.service.registerKind(handoffObjective())
    const enrolled = await world.service.enroll(objectiveInput)
    if (enrolled.status !== 'enrolled') {
      throw new Error('Expected objective enrollment')
    }
    const objectiveId = enrolled.entry.enrollment.watcherId

    await world.service.reconcileForTesting(objectiveId)

    expect(world.enrollmentStore.list()).toHaveLength(1)
    expect(world.enrollmentStore.get(objectiveId)?.terminalAtMs).toBe(100)
    expect(world.service.ledger(objectiveId).entries).toEqual([
      expect.objectContaining({ kind: 'terminal' })
    ])
    await world.service.stopForShutdown()
  })

  it('writes no terminal or sitter after authorization loses the lease', async () => {
    const world = await harness()
    world.service.registerKind(
      handoffSitter({
        authorizeEnrollment: async (enrollment) => {
          world.assertHeld.mockRejectedValueOnce(new Error('lease lost'))
          return authorized(enrollment)
        }
      })
    )
    world.service.registerKind(handoffObjective())
    const enrolled = await world.service.enroll(objectiveInput)
    if (enrolled.status !== 'enrolled') {
      throw new Error('Expected objective enrollment')
    }
    const objectiveId = enrolled.entry.enrollment.watcherId

    await world.service.reconcileForTesting(objectiveId)

    expect(world.enrollmentStore.list()).toHaveLength(1)
    expect(world.enrollmentStore.get(objectiveId)).toMatchObject({
      enabled: true,
      terminalAtMs: null
    })
    expect(
      world.service
        .ledger(objectiveId)
        .entries.some(
          (entry) =>
            entry.kind === 'terminal' ||
            (entry.kind === 'evidence' && entry.evidenceKind === 'handoff')
        )
    ).toBe(false)
    await world.service.stopForShutdown()
  })

  it('rolls the objective terminal and ledger back when sitter insertion fails', async () => {
    const world = await harness()
    world.service.registerKind(handoffSitter())
    world.service.registerKind(handoffObjective())
    const enrolled = await world.service.enroll(objectiveInput)
    if (enrolled.status !== 'enrolled') {
      throw new Error('Expected objective enrollment')
    }
    const objectiveId = enrolled.entry.enrollment.watcherId
    const insert = world.enrollmentStore.insert.bind(world.enrollmentStore)
    vi.spyOn(world.enrollmentStore, 'insert').mockImplementation((enrollment) => {
      if (enrollment.kind === 'hosted-review') {
        throw new Error('sitter insert failed')
      }
      return insert(enrollment)
    })

    await world.service.reconcileForTesting(objectiveId)

    expect(world.enrollmentStore.list()).toHaveLength(1)
    expect(world.enrollmentStore.get(objectiveId)).toMatchObject({
      enabled: true,
      terminalAtMs: null
    })
    expect(
      world.service
        .ledger(objectiveId)
        .entries.some(
          (entry) =>
            entry.kind === 'terminal' ||
            (entry.kind === 'evidence' && entry.evidenceKind === 'handoff')
        )
    ).toBe(false)
    await world.service.stopForShutdown()
  })

  it('retries a duplicate workspace insertion as a refused terminal handoff', async () => {
    const world = await harness()
    world.service.registerKind(handoffSitter())
    world.service.registerKind(handoffObjective())
    const enrolled = await world.service.enroll(objectiveInput)
    if (enrolled.status !== 'enrolled') {
      throw new Error('Expected objective enrollment')
    }
    const objectiveId = enrolled.entry.enrollment.watcherId
    const collision = Object.assign(
      new Error('UNIQUE constraint failed: heimdall_enrollment.workspace_key'),
      { code: 'SQLITE_CONSTRAINT_UNIQUE' }
    )
    vi.spyOn(world.enrollmentStore, 'insert').mockImplementationOnce(() => {
      throw collision
    })

    await world.service.reconcileForTesting(objectiveId)

    expect(world.enrollmentStore.list()).toHaveLength(1)
    expect(world.enrollmentStore.get(objectiveId)?.terminalAtMs).toBe(100)
    expect(world.service.ledger(objectiveId).entries).toEqual([
      expect.objectContaining({ kind: 'terminal' })
    ])
    await world.service.stopForShutdown()
  })
})
