import { describe, expect, it, vi } from 'vitest'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import { enrollmentInput, harness, kind, type World } from './kernel-service-test-harness'

vi.mock('electron', () => ({}))

const LIVE_SNAPSHOT: Snapshot<World> = {
  freshness: 'live',
  contentIdentity: 'revision-1',
  observedAtMs: 1,
  world: { revision: 'revision-1' }
}

describe('Heimdall watcher deletion', () => {
  it('drains an active tick before purging durable state without stopping worker terminals', async () => {
    let markReadStarted!: () => void
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve
    })
    let finishRead!: () => void
    const readGate = new Promise<void>((resolve) => {
      finishRead = resolve
    })
    const purge = vi.fn()
    const world = await harness()
    world.service.registerKind(
      kind({
        purge,
        read: async () => {
          markReadStarted()
          await readGate
          return LIVE_SNAPSHOT
        }
      })
    )
    const enrolled = await world.service.enroll(enrollmentInput())
    if (enrolled.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const watcherId = enrolled.entry.enrollment.watcherId
    world.ledgerStore.append({
      eventId: 'durable-evidence',
      watcherId,
      atMs: 1,
      origin: 'owner',
      class: 'fact',
      kind: 'evidence',
      evidenceKind: 'fixture',
      payload: { retained: true }
    })
    world.schedule.mockClear()

    const tick = world.service.reconcileForTesting(watcherId)
    await readStarted
    const row = (await world.service.fleet()).entries[0]!
    const deletion = world.service.command({
      target: row.target,
      expectedOwner: row.ownerFence,
      command: { kind: 'delete' }
    })
    await Promise.resolve()
    expect(purge).not.toHaveBeenCalled()
    expect(world.enrollmentStore.get(watcherId)).not.toBeNull()

    finishRead()
    await tick
    await expect(deletion).resolves.toMatchObject({ status: 'applied' })

    expect(purge).toHaveBeenCalledWith(watcherId)
    expect(world.enrollmentStore.get(watcherId)).toBeNull()
    expect(world.ledgerStore.read(watcherId).entries).toEqual([])
    expect(world.ledgerStore.readTickTraces(watcherId)).toEqual([])
    expect(world.ledgerStore.readTerminalSummary(watcherId)).toBeNull()
    await expect(world.service.fleet()).resolves.toMatchObject({ entries: [] })
    await expect(world.service.reconcileForTesting(watcherId)).rejects.toThrow(
      `Unknown Heimdall runner: ${watcherId}`
    )
    expect(world.schedule).not.toHaveBeenCalled()
    expect(world.orchestration.stopWorker).not.toHaveBeenCalled()
    expect(world.orchestration.releaseWorker).not.toHaveBeenCalled()
    await world.service.stopForShutdown()
  })

  it('deletes before the first recovered pulse with a prior-process budget interval', async () => {
    const purge = vi.fn()
    const world = await harness()
    world.service.registerKind(kind({ purge }))
    const enrolled = await world.service.enroll(enrollmentInput())
    if (enrolled.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const watcherId = enrolled.entry.enrollment.watcherId
    world.ledgerStore.append({
      kind: 'interval-open',
      eventId: 'prior-process-interval',
      watcherId,
      atMs: 10,
      origin: 'owner',
      class: 'fact',
      intervalId: 'prior-process-interval',
      cause: 'action-in-flight'
    })
    const row = (await world.service.fleet()).entries[0]!

    await expect(
      world.service.command({
        target: row.target,
        expectedOwner: row.ownerFence,
        command: { kind: 'delete' }
      })
    ).resolves.toMatchObject({ status: 'applied' })

    expect(purge).toHaveBeenCalledOnce()
    expect(world.enrollmentStore.get(watcherId)).toBeNull()
    await expect(world.service.fleet()).resolves.toMatchObject({ entries: [] })
    await world.service.stopForShutdown()
  })

  it('keeps deletion owner-fenced and retryable when an owned interval close cannot persist', async () => {
    const purge = vi.fn()
    const world = await harness()
    world.service.registerKind(kind({ purge }))
    const enrolled = await world.service.enroll(enrollmentInput())
    if (enrolled.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const watcherId = enrolled.entry.enrollment.watcherId
    const interval = world.budgetClock.open(watcherId, 'worker-dispatched')
    const initial = (await world.service.fleet()).entries[0]!
    const append = world.ledgerStore.append.bind(world.ledgerStore)
    let failRecovery = true
    vi.spyOn(world.ledgerStore, 'append').mockImplementation((entry, options) => {
      if (entry.kind === 'interval-close' && failRecovery) {
        failRecovery = false
        throw new Error('budget close persistence failed')
      }
      return append(entry, options)
    })

    await expect(
      world.service.command({
        target: initial.target,
        expectedOwner: initial.ownerFence,
        command: { kind: 'delete' }
      })
    ).resolves.toEqual({
      status: 'indeterminate',
      detail: 'budget close persistence failed'
    })
    expect(world.enrollmentStore.get(watcherId)).not.toBeNull()
    expect(purge).not.toHaveBeenCalled()
    expect(world.budgetClock.owned(watcherId)).toEqual(interval)

    const retry = (await world.service.fleet()).entries[0]!
    await expect(
      world.service.command({
        target: retry.target,
        expectedOwner: retry.ownerFence,
        command: { kind: 'delete' }
      })
    ).resolves.toMatchObject({ status: 'applied' })
    expect(purge).toHaveBeenCalledOnce()
    expect(world.enrollmentStore.get(watcherId)).toBeNull()
    await world.service.stopForShutdown()
  })

  it('keeps stale and incorrect owners from deleting, then deletes a disarmed watcher', async () => {
    const purge = vi.fn()
    const world = await harness()
    world.service.registerKind(kind({ purge }))
    const enrolled = await world.service.enroll(enrollmentInput())
    if (enrolled.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const initial = (await world.service.fleet()).entries[0]!

    await expect(
      world.service.command({
        target: initial.target,
        expectedOwner: { ...initial.ownerFence, revision: initial.ownerFence.revision + 1 },
        command: { kind: 'delete' }
      })
    ).resolves.toMatchObject({ status: 'refused', reason: 'stale-revision' })
    await expect(
      world.service.command({
        target: initial.target,
        expectedOwner: { ...initial.ownerFence, workspaceKey: 'local::/other-worktree' },
        command: { kind: 'delete' }
      })
    ).resolves.toMatchObject({ status: 'refused', reason: 'owner-conflict' })
    expect(purge).not.toHaveBeenCalled()

    await expect(
      world.service.command({
        target: initial.target,
        expectedOwner: initial.ownerFence,
        command: { kind: 'disarm' }
      })
    ).resolves.toMatchObject({ status: 'applied' })
    const disarmed = (await world.service.fleet()).entries[0]!
    expect(disarmed.entry.enrollment.enabled).toBe(false)

    await expect(
      world.service.command({
        target: disarmed.target,
        expectedOwner: disarmed.ownerFence,
        command: { kind: 'delete' }
      })
    ).resolves.toMatchObject({ status: 'applied' })
    expect(purge).toHaveBeenCalledOnce()
    await expect(world.service.fleet()).resolves.toMatchObject({ entries: [] })
    await world.service.stopForShutdown()
  })

  it('resumes a concurrently re-armed disarmed watcher when deletion loses its revision fence', async () => {
    let markReadStarted!: () => void
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve
    })
    let finishRead!: () => void
    const readGate = new Promise<void>((resolve) => {
      finishRead = resolve
    })
    const world = await harness()
    world.service.registerKind(
      kind({
        read: async () => {
          markReadStarted()
          await readGate
          return LIVE_SNAPSHOT
        }
      })
    )
    const enrolled = await world.service.enroll(enrollmentInput())
    if (enrolled.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const initial = (await world.service.fleet()).entries[0]!
    await world.service.command({
      target: initial.target,
      expectedOwner: initial.ownerFence,
      command: { kind: 'disarm' }
    })
    const disarmed = (await world.service.fleet()).entries[0]!
    world.schedule.mockClear()
    const tick = world.service.reconcileForTesting(disarmed.target.watcherId)
    await readStarted
    const deletion = world.service.command({
      target: disarmed.target,
      expectedOwner: disarmed.ownerFence,
      command: { kind: 'delete' }
    })
    await Promise.resolve()
    const rearmed = await world.service.enroll(enrollmentInput())
    expect(rearmed.status).toBe('re-armed')

    finishRead()
    await tick
    await expect(deletion).resolves.toMatchObject({ status: 'refused', reason: 'stale-revision' })
    expect((await world.service.fleet()).entries[0]?.entry.enrollment.enabled).toBe(true)
    expect(world.schedule).toHaveBeenCalled()
    await world.service.stopForShutdown()
  })

  it('deletes a terminal watcher and its compacted summary', async () => {
    const purge = vi.fn()
    const world = await harness()
    world.service.registerKind(
      kind({
        purge,
        stopPredicates: [
          {
            id: 'fixture-complete',
            disposition: 'terminal',
            evaluate: () => ({ stop: true, reason: 'fixture-complete' })
          }
        ]
      })
    )
    const enrolled = await world.service.enroll(enrollmentInput())
    if (enrolled.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const watcherId = enrolled.entry.enrollment.watcherId
    await world.service.reconcileForTesting(watcherId)
    const terminal = (await world.service.fleet()).entries[0]!
    expect(terminal.entry.status.state).toBe('terminal')
    expect(world.ledgerStore.readTerminalSummary(watcherId)).not.toBeNull()

    await expect(
      world.service.command({
        target: terminal.target,
        expectedOwner: terminal.ownerFence,
        command: { kind: 'delete' }
      })
    ).resolves.toMatchObject({ status: 'applied' })
    expect(world.enrollmentStore.get(watcherId)).toBeNull()
    expect(world.ledgerStore.read(watcherId).entries).toEqual([])
    expect(world.ledgerStore.readTerminalSummary(watcherId)).toBeNull()
    expect(purge).toHaveBeenCalledWith(watcherId)
    await world.service.stopForShutdown()
  })

  it('replays kind cleanup after a purge failure and process restart', async () => {
    const failingPurge = vi.fn(() => {
      throw new Error('fixture purge failed')
    })
    const world = await harness()
    world.service.registerKind(kind({ purge: failingPurge }))
    const enrolled = await world.service.enroll(enrollmentInput())
    if (enrolled.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const watcherId = enrolled.entry.enrollment.watcherId
    const row = (await world.service.fleet()).entries[0]!

    await expect(
      world.service.command({
        target: row.target,
        expectedOwner: row.ownerFence,
        command: { kind: 'delete' }
      })
    ).resolves.toMatchObject({ status: 'indeterminate', detail: 'fixture purge failed' })
    expect(world.enrollmentStore.get(watcherId)).toBeNull()
    expect(world.enrollmentStore.pendingKindPurges()).toEqual([
      { watcherId, kind: 'hosted-review' }
    ])
    await world.service.stopForShutdown()

    const recoveredPurge = vi.fn()
    const restarted = await harness({ directory: world.directory })
    restarted.service.registerKind(kind({ purge: recoveredPurge }))
    await expect(restarted.service.fleet()).resolves.toMatchObject({ entries: [] })
    expect(recoveredPurge).toHaveBeenCalledWith(watcherId)
    expect(restarted.enrollmentStore.pendingKindPurges()).toEqual([])
    await restarted.service.stopForShutdown()
  })
})
