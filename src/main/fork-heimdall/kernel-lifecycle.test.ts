import { describe, expect, it, vi } from 'vitest'
import type {
  ExecuteContext,
  KernelAction,
  LeaseGuard
} from '../../shared/fork-heimdall/kind-contract'
import {
  getInFlightAttempts,
  getUnresolvedAttempts
} from '../../shared/fork-heimdall/ledger-queries'
import type {
  AttemptEntry,
  LedgerEntry,
  WatcherLedger
} from '../../shared/fork-heimdall/ledger-types'
import type { LiveSnapshot } from '../../shared/fork-heimdall/snapshot'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import {
  action,
  attempted,
  authorized,
  harness,
  input,
  runningDispatch,
  watcherKind,
  type World
} from './kernel-lifecycle-test-harness'

vi.mock('electron', () => ({}))

describe('Heimdall kernel terminal and local recovery lifecycle', () => {
  it('rejects kind-invalid enrollment state before persistence', async () => {
    const world = await harness()
    const validateEnrollment = vi.fn(() => {
      throw new Error('configuration-cannot-progress')
    })
    world.service.registerKind(watcherKind({ validateEnrollment }))

    await expect(world.service.enroll(input)).resolves.toEqual({
      status: 'refused',
      reason: 'invalid-payload',
      detail: 'configuration-cannot-progress'
    })
    expect(validateEnrollment).toHaveBeenCalledWith(authorized(input), null)
    expect(world.enrollmentStore.list()).toEqual([])
  })

  it('rejects kind-invalid re-enrollment before rearming the existing watcher', async () => {
    const world = await harness()
    let reject = false
    const validateEnrollment = vi.fn(() => {
      if (reject) {
        throw new Error('configuration-cannot-progress')
      }
    })
    world.service.registerKind(watcherKind({ validateEnrollment }))
    const enrolled = await world.service.enroll(input)
    if (enrolled.status !== 'enrolled') {
      throw new Error('Expected enrollment')
    }
    const existing = enrolled.entry.enrollment
    const disabled = world.enrollmentStore.setEnabled(existing.watcherId, false)
    reject = true

    await expect(world.service.enroll(input)).resolves.toEqual({
      status: 'refused',
      reason: 'invalid-payload',
      detail: 'configuration-cannot-progress'
    })
    expect(validateEnrollment).toHaveBeenLastCalledWith(
      authorized(input),
      expect.objectContaining({ watcherId: existing.watcherId, enabled: false })
    )
    expect(world.enrollmentStore.get(existing.watcherId)).toMatchObject({
      enabled: false,
      commandRevision: disabled.commandRevision
    })
  })

  it('defers terminal for a worker and survives restart', async () => {
    let watcherId = ''
    let mailbox: LedgerEntry[] = []
    const world = await harness({ mailbox: () => mailbox })
    const terminalKind = watcherKind({
      stopPredicates: [
        {
          id: 'objective-complete',
          disposition: 'terminal',
          evaluate: () => ({ stop: true, reason: 'files-on-disk' })
        }
      ]
    })
    world.service.registerKind(terminalKind)
    const enrolled = await world.service.enroll(input)
    if (enrolled.status !== 'enrolled') {
      throw new Error('Expected enrollment')
    }
    watcherId = enrolled.entry.enrollment.watcherId
    for (const entry of runningDispatch(watcherId)) {
      world.ledgerStore.append(entry)
    }
    world.ledgerStore.append({
      eventId: 'turn-1',
      watcherId,
      atMs: 15,
      origin: 'owner',
      class: 'fact',
      kind: 'turn',
      dispatchKind: 'child',
      attemptId: 'attempt-1',
      dispatchId: 'dispatch-1'
    })
    world.ledgerStore.append(
      {
        eventId: 'retention-pinned-observation',
        watcherId,
        atMs: 16,
        origin: 'client',
        class: 'observation',
        kind: 'client-observation',
        what: 'keep-through-terminal-compaction'
      },
      { resolved: false }
    )

    await world.service.reconcileForTesting(watcherId)
    expect(world.enrollmentStore.get(watcherId)).toMatchObject({
      terminalAtMs: null,
      enabled: true
    })
    expect(world.leaseStore.release).not.toHaveBeenCalled()

    mailbox = [
      {
        eventId: 'worker-done',
        watcherId,
        atMs: 20,
        origin: 'owner',
        class: 'fact',
        kind: 'evidence',
        evidenceKind: 'orchestration-mailbox',
        payload: {
          type: 'worker_done',
          payload: { dispatchId: 'dispatch-1', outcome: 'succeeded', taskId: 'task-1' }
        }
      }
    ]
    await world.service.reconcileForTesting(watcherId)
    mailbox = []
    await world.service.reconcileForTesting(watcherId)

    expect(world.enrollmentStore.get(watcherId)).toMatchObject({
      terminalAtMs: 100,
      enabled: false
    })
    expect(world.service.ledger(watcherId).entries).toEqual([
      expect.objectContaining({ eventId: 'retention-pinned-observation' }),
      expect.objectContaining({
        kind: 'terminal',
        state: 'objective-complete',
        reason: 'files-on-disk',
        atMs: 100
      })
    ])
    expect(world.ledgerStore.readTerminalSummary(watcherId)).toMatchObject({
      terminalState: 'objective-complete',
      reason: 'files-on-disk',
      totals: { activeMs: 0, turns: 1, exhausted: null }
    })
    expect((await world.service.list())[0]).toMatchObject({
      status: {
        state: 'terminal',
        reason: 'files-on-disk',
        budget: { activeMs: 0, turns: 1, exhausted: null }
      }
    })
    expect(await world.service.debugReport(watcherId)).toMatchObject({
      status: { budget: { activeMs: 0, turns: 1, exhausted: null } },
      budget: { activeMs: 0, turns: 1, exhausted: null }
    })
    expect(world.leaseStore.release).toHaveBeenCalled()
    await world.service.stopForShutdown()

    const restarted = await harness({ directory: world.directory })
    restarted.service.registerKind(terminalKind)
    restarted.schedule.mockClear()
    expect((await restarted.service.list())[0]).toMatchObject({
      enrollment: { terminalAtMs: 100, enabled: false },
      status: {
        state: 'terminal',
        phase: 'terminal',
        reason: 'files-on-disk',
        budget: { activeMs: 0, turns: 1, exhausted: null }
      }
    })
    expect(await restarted.service.debugReport(watcherId)).toMatchObject({
      status: { budget: { activeMs: 0, turns: 1, exhausted: null } },
      budget: { activeMs: 0, turns: 1, exhausted: null }
    })
    expect(restarted.ledgerStore.readTerminalSummary(watcherId)).toMatchObject({
      terminalState: 'objective-complete',
      reason: 'files-on-disk',
      totals: { activeMs: 0, turns: 1, exhausted: null }
    })
    restarted.service.resume()
    expect(restarted.schedule).not.toHaveBeenCalled()
    expect(restarted.service.ledger(watcherId).entries).toEqual([
      expect.objectContaining({ eventId: 'retention-pinned-observation' }),
      expect.objectContaining({ kind: 'terminal', reason: 'files-on-disk' })
    ])
    await restarted.service.stopForShutdown()
  })

  it('keeps polling a running worker after a park predicate fires', async () => {
    let watcherId = ''
    let mailbox: LedgerEntry[] = []
    const world = await harness({ mailbox: () => mailbox })
    world.service.registerKind(
      watcherKind({
        stopPredicates: [
          {
            id: 'higher-bar',
            evaluate: () => ({ stop: true, reason: 'awaiting-phase-4' })
          }
        ]
      })
    )
    const enrolled = await world.service.enroll(input)
    if (enrolled.status !== 'enrolled') {
      throw new Error('Expected enrollment')
    }
    watcherId = enrolled.entry.enrollment.watcherId
    for (const entry of runningDispatch(watcherId)) {
      world.ledgerStore.append(entry)
    }
    world.schedule.mockClear()

    await world.service.reconcileForTesting(watcherId)
    expect(world.enrollmentStore.get(watcherId)).toMatchObject({
      enabled: false,
      terminalAtMs: null
    })
    expect(world.schedule).toHaveBeenCalled()
    expect(world.leaseStore.release).not.toHaveBeenCalled()

    mailbox = [
      {
        eventId: 'parked-worker-done',
        watcherId,
        atMs: 20,
        origin: 'owner',
        class: 'fact',
        kind: 'evidence',
        evidenceKind: 'orchestration-mailbox',
        payload: {
          type: 'worker_done',
          payload: { dispatchId: 'dispatch-1', outcome: 'succeeded', taskId: 'task-1' }
        }
      }
    ]
    await world.service.reconcileForTesting(watcherId)
    mailbox = []
    await world.service.reconcileForTesting(watcherId)

    expect(world.leaseStore.release).toHaveBeenCalled()
    expect(world.service.ledger(watcherId).entries.some((entry) => entry.kind === 'terminal')).toBe(
      false
    )
    await world.service.stopForShutdown()
  })

  it('does not seal terminal state while an outcome remains unresolved', async () => {
    let effect: 'indeterminate' | 'not-landed' = 'indeterminate'
    const world = await harness()
    world.service.registerKind(
      watcherKind({
        resolveOutcome: async () => ({ effect }),
        stopPredicates: [
          {
            id: 'objective-complete',
            disposition: 'terminal',
            evaluate: () => ({ stop: true, reason: 'files-on-disk' })
          }
        ]
      })
    )
    const enrolled = await world.service.enroll(input)
    if (enrolled.status !== 'enrolled') {
      throw new Error('Expected enrollment')
    }
    const watcherId = enrolled.entry.enrollment.watcherId
    const writeAhead = attempted(watcherId, action('revision-1'))
    world.ledgerStore.append(writeAhead)
    world.ledgerStore.append({
      ...writeAhead,
      eventId: 'uncertain-local',
      state: 'settled' as const,
      effect: 'indeterminate' as const,
      reason: 'crash-before-settlement'
    })

    await world.service.reconcileForTesting(watcherId)
    expect(world.enrollmentStore.get(watcherId)).toMatchObject({ terminalAtMs: null })
    expect(getUnresolvedAttempts(world.service.ledger(watcherId))).toHaveLength(1)

    effect = 'not-landed'
    await world.service.reconcileForTesting(watcherId)
    expect(world.enrollmentStore.get(watcherId)).toMatchObject({ terminalAtMs: 100 })
    expect(getUnresolvedAttempts(world.service.ledger(watcherId))).toHaveLength(0)
    await world.service.stopForShutdown()
  })

  it('does not persist a probe result after losing its lease during the probe', async () => {
    let finishProbe!: (resolution: { effect: 'not-landed' }) => void
    const probe = new Promise<{ effect: 'not-landed' }>((resolve) => {
      finishProbe = resolve
    })
    const resolveOutcome = vi.fn(() => probe)
    const world = await harness()
    world.service.registerKind(watcherKind({ resolveOutcome }))
    const enrolled = await world.service.enroll(input)
    if (enrolled.status !== 'enrolled') {
      throw new Error('Expected enrollment')
    }
    const watcherId = enrolled.entry.enrollment.watcherId
    const writeAhead = attempted(watcherId, action('revision-1'))
    world.ledgerStore.append(writeAhead)
    world.ledgerStore.append({
      ...writeAhead,
      eventId: 'uncertain-probe',
      state: 'settled' as const,
      effect: 'indeterminate' as const,
      reason: 'crash-before-settlement'
    })

    const reconciliation = world.service.reconcileForTesting(watcherId)
    await vi.waitFor(() => expect(resolveOutcome).toHaveBeenCalledOnce())
    world.assertHeld.mockRejectedValueOnce(new Error('stale lease'))
    finishProbe({ effect: 'not-landed' })
    await reconciliation

    const ledger = world.service.ledger(watcherId)
    expect(ledger.entries.some((entry) => entry.kind === 'attempt-resolved')).toBe(false)
    expect(getUnresolvedAttempts(ledger)).toHaveLength(1)
    await world.service.stopForShutdown()
  })

  it('repairs a terminal fact committed before the enrollment marker', async () => {
    const world = await harness()
    const enrollment: WatcherEnrollment = {
      ...authorized(input),
      watcherId: 'watcher-crash-gap',
      enabled: true,
      paused: false,
      commandRevision: 0,
      coordinatorIdentity: { handle: 'coordinator', paneKey: 'pane' },
      orchestrationRunId: null,
      createdAtMs: 1,
      terminalAtMs: null
    }
    world.enrollmentStore.insert(enrollment)
    world.ledgerStore.append({
      eventId: 'resolved-before-terminal',
      watcherId: enrollment.watcherId,
      atMs: 54,
      origin: 'owner',
      class: 'fact',
      kind: 'evidence',
      evidenceKind: 'fixture',
      payload: { resolved: true }
    })
    world.ledgerStore.append({
      eventId: 'terminal-before-marker',
      watcherId: enrollment.watcherId,
      atMs: 55,
      origin: 'owner',
      class: 'fact',
      kind: 'terminal',
      state: 'objective-complete',
      reason: 'files-on-disk'
    })
    world.service.registerKind(watcherKind())

    expect((await world.service.list())[0]).toMatchObject({
      enrollment: { terminalAtMs: 55, enabled: false },
      status: { state: 'terminal' }
    })
    expect(world.service.ledger(enrollment.watcherId).entries).toEqual([
      expect.objectContaining({
        eventId: 'terminal-before-marker',
        kind: 'terminal',
        reason: 'files-on-disk'
      })
    ])
    expect(world.ledgerStore.readTerminalSummary(enrollment.watcherId)).toMatchObject({
      terminalState: 'objective-complete',
      reason: 'files-on-disk'
    })
    await world.service.stopForShutdown()
  })

  it('recovers a concrete dispatch receipt before kind outcome probing', async () => {
    const resolveOutcome = vi.fn(async () => ({ effect: 'indeterminate' as const }))
    const world = await harness({
      recoverDispatch: async () => ({
        status: 'dispatched',
        dispatchId: 'dispatch-recovered'
      })
    })
    world.service.registerKind(watcherKind({ resolveOutcome }))
    const enrolled = await world.service.enroll(input)
    if (enrolled.status !== 'enrolled') {
      throw new Error('Expected enrollment')
    }
    const watcherId = enrolled.entry.enrollment.watcherId
    const writeAhead = {
      ...attempted(watcherId, action('revision-1')),
      dispatch: {
        spec: 'Implement the node.',
        taskKey: 'node-1',
        deps: ['task-plan'],
        dispatchKind: 'child' as const
      }
    }
    world.ledgerStore.append(writeAhead)
    world.ledgerStore.append({
      ...writeAhead,
      eventId: 'uncertain-dispatch',
      state: 'settled' as const,
      effect: 'indeterminate' as const,
      reason: 'operation-unknown'
    })

    await world.service.reconcileForTesting(watcherId)
    const ledger = world.service.ledger(watcherId)

    expect(world.orchestration.recoverDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ deps: ['task-plan'] })
    )
    expect(getInFlightAttempts(ledger)).toEqual([
      expect.objectContaining({
        attemptId: 'attempt-1',
        state: 'running',
        dispatchId: 'dispatch-recovered',
        dispatch: expect.objectContaining({ deps: ['task-plan'] })
      })
    ])
    expect(ledger.entries.filter((entry) => entry.kind === 'turn')).toHaveLength(1)
    expect(resolveOutcome).not.toHaveBeenCalled()
    await world.service.stopForShutdown()
  })

  it('replays an identity-current action marked replay-safe under the lease', async () => {
    const execute = vi.fn(async (_action: KernelAction, context: ExecuteContext<World>) => {
      await context.lease.assertHeld()
      return { effect: 'landed' as const, result: { naturalKey: 'revision-1' } }
    })
    const world = await harness()
    world.service.registerKind(
      watcherKind({ resolveOutcome: async () => ({ effect: 'not-landed' as const }), execute })
    )
    const enrolled = await world.service.enroll(input)
    if (enrolled.status !== 'enrolled') {
      throw new Error('Expected enrollment')
    }
    const watcherId = enrolled.entry.enrollment.watcherId
    world.ledgerStore.append(attempted(watcherId, action('revision-1', 'replay-safe')))

    await world.service.reconcileForTesting(watcherId)

    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0]![0]).toMatchObject({
      recovery: 'replay-safe',
      evidenceKey: 'write:revision-1'
    })
    expect(world.assertHeld).toHaveBeenCalled()
    expect(world.service.ledger(watcherId).entries).toContainEqual(
      expect.objectContaining({
        kind: 'attempt',
        attemptId: 'attempt-1',
        state: 'settled',
        effect: 'landed'
      })
    )
    await world.service.stopForShutdown()
  })

  it('settles an absent dispatch receipt while its watcher is disabled', async () => {
    const resolveOutcome = vi.fn(async () => ({ effect: 'indeterminate' as const }))
    const world = await harness()
    const enrollment: WatcherEnrollment = {
      ...authorized(input),
      watcherId: 'watcher-disabled-recovery',
      enabled: false,
      paused: false,
      commandRevision: 0,
      coordinatorIdentity: { handle: 'coordinator', paneKey: 'pane' },
      orchestrationRunId: null,
      createdAtMs: 1,
      terminalAtMs: null
    }
    world.enrollmentStore.insert(enrollment)
    const writeAhead = {
      ...attempted(enrollment.watcherId, action('revision-1')),
      dispatch: { spec: 'Dispatch before disarm.', dispatchKind: 'child' as const }
    } as const satisfies LedgerEntry
    world.ledgerStore.append(writeAhead)
    world.service.registerKind(watcherKind({ resolveOutcome }))

    await world.service.reconcileForTesting(enrollment.watcherId)
    const ledger = world.service.ledger(enrollment.watcherId)

    expect(world.orchestration.recoverDispatch).toHaveBeenCalledOnce()
    expect(resolveOutcome).not.toHaveBeenCalled()
    expect(getInFlightAttempts(ledger)).toEqual([])
    expect(ledger.entries).toContainEqual(
      expect.objectContaining({
        kind: 'attempt',
        state: 'settled',
        effect: 'not-landed',
        reason: 'dispatch-receipt-absent'
      })
    )
    await world.service.stopForShutdown()
  })

  it('does not replay a probe-only action with an uncertain shell effect', async () => {
    const execute = vi.fn(async () => ({ effect: 'landed' as const }))
    const world = await harness()
    world.service.registerKind(
      watcherKind({ resolveOutcome: async () => ({ effect: 'indeterminate' as const }), execute })
    )
    const enrolled = await world.service.enroll(input)
    if (enrolled.status !== 'enrolled') {
      throw new Error('Expected enrollment')
    }
    const watcherId = enrolled.entry.enrollment.watcherId
    world.ledgerStore.append(attempted(watcherId, action('revision-1')))

    await world.service.reconcileForTesting(watcherId)
    const ledger = world.service.ledger(watcherId)

    expect(execute).not.toHaveBeenCalled()
    expect(getInFlightAttempts(ledger)).toEqual([])
    expect(getUnresolvedAttempts(ledger)).toEqual([
      expect.objectContaining({ attemptId: 'attempt-1', effect: 'indeterminate' })
    ])
    await world.service.stopForShutdown()
  })

  it('probes stale replay-safe work without replaying it at the new identity', async () => {
    const execute = vi.fn(async () => ({ effect: 'landed' as const }))
    const resolveOutcome = vi.fn(async () => ({ effect: 'not-landed' as const }))
    const world = await harness()
    world.service.registerKind(watcherKind({ execute, resolveOutcome }))
    const enrolled = await world.service.enroll(input)
    if (enrolled.status !== 'enrolled') {
      throw new Error('Expected enrollment')
    }
    const watcherId = enrolled.entry.enrollment.watcherId
    world.ledgerStore.append(attempted(watcherId, action('stale-revision', 'replay-safe')))

    await world.service.reconcileForTesting(watcherId)

    expect(resolveOutcome).toHaveBeenCalledOnce()
    expect(execute).not.toHaveBeenCalled()
    expect(world.service.ledger(watcherId).entries).toContainEqual(
      expect.objectContaining({
        kind: 'attempt',
        state: 'settled',
        effect: 'not-landed',
        reason: 'local-action-recovery-probe'
      })
    )
    expect(
      world.service.ledger(watcherId).entries.some((entry) => entry.kind === 'attempt-abandoned')
    ).toBe(false)
    await world.service.stopForShutdown()
  })

  it('accepts authoritative landed repair after a local action changes identity', async () => {
    const execute = vi.fn(async () => ({ effect: 'landed' as const }))
    const repairMissingRung = vi.fn()
    const resolveOutcome = vi.fn(
      async (
        _attempt: AttemptEntry,
        _fresh: LiveSnapshot<World>,
        _ledger: WatcherLedger,
        lease: LeaseGuard
      ) => {
        await lease.assertHeld()
        repairMissingRung()
        return { effect: 'landed' as const }
      }
    )
    const world = await harness()
    world.service.registerKind(watcherKind({ execute, resolveOutcome }))
    const enrolled = await world.service.enroll(input)
    if (enrolled.status !== 'enrolled') {
      throw new Error('Expected enrollment')
    }
    const watcherId = enrolled.entry.enrollment.watcherId
    world.ledgerStore.append(attempted(watcherId, action('stale-revision', 'replay-safe')))

    await world.service.reconcileForTesting(watcherId)

    expect(resolveOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        action: expect.objectContaining({ contentIdentity: 'stale-revision' })
      }),
      expect.objectContaining({ contentIdentity: 'revision-1' }),
      expect.any(Object),
      expect.objectContaining({ epoch: 1, assertHeld: expect.any(Function) })
    )
    expect(repairMissingRung).toHaveBeenCalledOnce()
    expect(execute).not.toHaveBeenCalled()
    expect(world.service.ledger(watcherId).entries).toContainEqual(
      expect.objectContaining({
        kind: 'attempt',
        state: 'settled',
        effect: 'landed',
        reason: 'local-action-recovery-probe'
      })
    )
    await world.service.stopForShutdown()
  })

  it('authoritatively probes an external attempt after an identity move', async () => {
    const execute = vi.fn(async () => ({ effect: 'landed' as const }))
    const resolveOutcome = vi.fn(async () => ({ effect: 'landed' as const }))
    const world = await harness()
    world.service.registerKind(watcherKind({ execute, resolveOutcome }))
    const enrolled = await world.service.enroll(input)
    if (enrolled.status !== 'enrolled') {
      throw new Error('Expected enrollment')
    }
    const watcherId = enrolled.entry.enrollment.watcherId
    const externalAction: KernelAction = {
      kind: 'push-ref',
      capability: 'land',
      visibility: 'external',
      contentIdentity: 'stale-revision',
      evidenceKey: 'push-ref:stale-revision',
      expectedState: { target: 'origin/feature', before: 'remote-before' }
    }
    world.ledgerStore.append(attempted(watcherId, externalAction))

    await world.service.reconcileForTesting(watcherId)

    expect(resolveOutcome).toHaveBeenCalledOnce()
    expect(execute).not.toHaveBeenCalled()
    expect(world.service.ledger(watcherId).entries).toContainEqual(
      expect.objectContaining({
        kind: 'attempt',
        state: 'settled',
        effect: 'landed',
        reason: 'local-action-recovery-probe'
      })
    )
    expect(
      world.service.ledger(watcherId).entries.some((entry) => entry.kind === 'attempt-abandoned')
    ).toBe(false)
    await world.service.stopForShutdown()
  })
})
