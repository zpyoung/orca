import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import type {
  ExecuteContext,
  KernelAction,
  LeaseGuard,
  WatcherKind
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
import type { LiveSnapshot, Snapshot } from '../../shared/fork-heimdall/snapshot'
import type { EnrollInput, WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { HeimdallBudgetClock } from './budget-clock'
import { HeimdallDatabase } from './database'
import { HeimdallEnrollmentStore } from './enrollment-store'
import { HeimdallKernelServiceImpl } from './kernel-service'
import { HeimdallLedgerStore } from './ledger-store'
import type { LeaseStore } from './lease-store'
import type { HeimdallOrchestrationAdapter } from './orchestration/orchestration-adapter'

vi.mock('electron', () => ({}))

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

type World = { revision: string }

const input: EnrollInput = {
  kind: 'hosted-review',
  repoId: 'repo-1',
  worktreeId: 'worktree-1',
  capabilities: { write: 'on' },
  budget: { wallClockActiveMs: 100_000, turns: 10 },
  kindPayload: { label: 'Recovery' }
}

function authorized(enrollment: EnrollInput) {
  return {
    kind: enrollment.kind,
    workspaceKey: 'local::/workspace/recovery' as const,
    executionHostId: 'local' as const,
    repoId: enrollment.repoId,
    worktreeId: enrollment.worktreeId,
    workspacePath: '/workspace/recovery',
    schedulerOwner: 'local_host_service' as const,
    capabilities: enrollment.capabilities,
    budget: enrollment.budget,
    kindPayload: enrollment.kindPayload
  }
}

function action(revision: string, recovery?: 'replay-safe'): KernelAction {
  return {
    kind: 'store-write',
    capability: 'write',
    visibility: 'local',
    contentIdentity: revision,
    evidenceKey: `write:${revision}`,
    ...(recovery ? { recovery } : {})
  }
}

function watcherKind(overrides: Partial<WatcherKind<World, KernelAction, { label: string }>> = {}) {
  const snapshot: Snapshot<World> = {
    freshness: 'live',
    contentIdentity: 'revision-1',
    observedAtMs: 100,
    world: { revision: 'revision-1' }
  }
  return {
    id: 'hosted-review',
    displayName: 'Hosted review',
    describeEnrollment: () => 'Recovery',
    enrollmentPayloadSchema: z.object({ label: z.string() }).strict(),
    authorizeEnrollment: async (enrollment: EnrollInput) => authorized(enrollment),
    read: async () => snapshot,
    describeSnapshot: (value: Snapshot<World>) => ({
      freshness: value.freshness,
      contentIdentity: value.contentIdentity,
      summary: value.world.revision
    }),
    decide: () => ({ action: null, reason: 'quiet', considered: [] }),
    execute: async () => ({ effect: 'landed' as const }),
    resolveOutcome: () => 'not-landed' as const,
    ...overrides
  } satisfies WatcherKind<World, KernelAction, { label: string }>
}

async function harness(
  options: {
    directory?: string
    mailbox?: () => LedgerEntry[]
    recoverDispatch?: HeimdallOrchestrationAdapter['recoverDispatch']
    dispatchObservation?: () => {
      status: 'live' | 'exited' | 'unverifiable'
      reason?: string
    }
  } = {}
) {
  const directory = options.directory ?? (await mkdtemp(join(tmpdir(), 'heimdall-lifecycle-')))
  if (!options.directory) {
    directories.push(directory)
  }
  const database = new HeimdallDatabase(directory)
  const enrollmentStore = new HeimdallEnrollmentStore(database)
  const ledgerStore = new HeimdallLedgerStore(database)
  const budgetClock = new HeimdallBudgetClock(ledgerStore, { now: () => 100 })
  const schedule = vi.fn()
  const assertHeld = vi.fn(async () => {})
  const leaseStore: LeaseStore = {
    acquireOrRenew: vi.fn(async () => ({
      status: 'held' as const,
      epoch: 1,
      guard: {
        epoch: 1,
        assertHeld,
        renewLoop: () => ({ dispose: vi.fn() })
      }
    })),
    release: vi.fn(async () => {})
  }
  const orchestration: HeimdallOrchestrationAdapter = {
    ensureRun: vi.fn(async () => ({ runId: 'run-1' })),
    dispatchWorker: vi.fn(async () => ({
      status: 'dispatched' as const,
      dispatchId: 'dispatch-1'
    })),
    recoverDispatch: vi.fn(
      options.recoverDispatch ?? (async () => ({ status: 'absent' as const }))
    ),
    readDispatch: vi.fn(async () => options.dispatchObservation?.() ?? { status: 'live' as const }),
    listWorkers: vi.fn(async () => []),
    stopWorker: vi.fn(async () => ({ status: 'applied' as const, appliedAtMs: 100 })),
    releaseWorker: vi.fn(async (_enrollment: WatcherEnrollment, dispatchId: string) => ({
      dispatchId,
      state: 'released' as const,
      processAction: 'closed_agent_terminal' as const,
      archive: null
    })),
    drainMailbox: vi.fn(async () => options.mailbox?.() ?? []),
    answerQuestion: vi.fn(async () => {}),
    readQuestion: vi.fn(async () => ({ status: 'pending' as const }))
  }
  let nextId = 0
  const service = new HeimdallKernelServiceImpl({
    runtime: {} as OrcaRuntimeService,
    store: {
      getProfileStorageDirectory: () => directory,
      getSettings: () => ({ notifications: { enabled: false } })
    } as unknown as Store,
    database,
    enrollmentStore,
    ledgerStore,
    budgetClock,
    leaseStore,
    orchestration,
    now: () => 100,
    createId: () => `id-${++nextId}`,
    setTimer: ((_callback: () => void, delay: number) => {
      schedule(delay)
      return { unref: () => {} } as NodeJS.Timeout
    }) as typeof setTimeout,
    clearTimer: vi.fn() as unknown as typeof clearTimeout,
    holderId: 'lifecycle-test'
  })
  return {
    service,
    database,
    directory,
    enrollmentStore,
    ledgerStore,
    leaseStore,
    orchestration,
    schedule,
    assertHeld
  }
}

function attempted(watcherId: string, attemptedAction: KernelAction): AttemptEntry {
  return {
    eventId: 'attempted-event',
    watcherId,
    atMs: 10,
    origin: 'owner',
    class: 'fact',
    kind: 'attempt',
    attemptId: 'attempt-1',
    fingerprint: makeAttemptFingerprint(
      attemptedAction.contentIdentity,
      attemptedAction.kind,
      attemptedAction.evidenceKey
    ),
    action: attemptedAction,
    state: 'attempted'
  }
}

function runningDispatch(watcherId: string): LedgerEntry[] {
  const writeAhead = {
    ...attempted(watcherId, action('revision-1')),
    dispatch: { spec: 'Finish the objective.', dispatchKind: 'child' as const }
  }
  return [
    writeAhead,
    {
      ...writeAhead,
      eventId: 'running-event',
      state: 'running' as const,
      dispatchId: 'dispatch-1'
    }
  ]
}

describe('Heimdall kernel terminal and local recovery lifecycle', () => {
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
    expect(
      world.service.ledger(watcherId).entries.filter((entry) => entry.kind === 'terminal')
    ).toEqual([
      expect.objectContaining({ state: 'objective-complete', reason: 'files-on-disk', atMs: 100 })
    ])
    expect((await world.service.list())[0]).toMatchObject({ status: { state: 'terminal' } })
    expect(world.leaseStore.release).toHaveBeenCalled()
    await world.service.stopForShutdown()

    const restarted = await harness({ directory: world.directory })
    restarted.service.registerKind(terminalKind)
    restarted.schedule.mockClear()
    expect((await restarted.service.list())[0]).toMatchObject({
      enrollment: { terminalAtMs: 100, enabled: false },
      status: { state: 'terminal', phase: 'terminal' }
    })
    restarted.service.resume()
    expect(restarted.schedule).not.toHaveBeenCalled()
    expect(
      restarted.service.ledger(watcherId).entries.filter((entry) => entry.kind === 'terminal')
    ).toHaveLength(1)
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
        resolveOutcome: async () => effect,
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
    let finishProbe!: (effect: 'not-landed') => void
    const probe = new Promise<'not-landed'>((resolve) => {
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
    finishProbe('not-landed')
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
    expect(
      world.service
        .ledger(enrollment.watcherId)
        .entries.filter((entry) => entry.kind === 'terminal')
    ).toHaveLength(1)
    await world.service.stopForShutdown()
  })

  it('recovers a concrete dispatch receipt before kind outcome probing', async () => {
    const resolveOutcome = vi.fn(async () => 'indeterminate' as const)
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
      watcherKind({ resolveOutcome: async () => 'not-landed' as const, execute })
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
    const resolveOutcome = vi.fn(async () => 'indeterminate' as const)
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
      watcherKind({ resolveOutcome: async () => 'indeterminate' as const, execute })
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
    const resolveOutcome = vi.fn(async () => 'not-landed' as const)
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
        return 'landed' as const
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
    const resolveOutcome = vi.fn(async () => 'landed' as const)
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
    expect(
      world.service
        .ledger(objectiveId)
        .entries.filter(
          (entry) =>
            (entry.kind === 'evidence' && entry.evidenceKind === 'handoff') ||
            entry.kind === 'terminal'
        )
        .map((entry) => entry.kind)
    ).toEqual(['evidence', 'terminal'])
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

  it('terminates with an escalation when sitter authorization is refused', async () => {
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
    expect(world.service.ledger(objectiveId).entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'escalation',
          escalationKind: 'handoff-refused',
          status: 'open',
          reason: 'review closed'
        }),
        expect.objectContaining({ kind: 'terminal' })
      ])
    )
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
    expect(world.service.ledger(objectiveId).entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'escalation',
          escalationKind: 'handoff-refused',
          reason: 'Authorized handoff workspace does not match the terminating watcher'
        }),
        expect.objectContaining({ kind: 'terminal' })
      ])
    )
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
    expect(world.service.ledger(objectiveId).entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'escalation',
          escalationKind: 'handoff-refused',
          reason: 'duplicate-workspace'
        }),
        expect.objectContaining({ kind: 'terminal' })
      ])
    )
    await world.service.stopForShutdown()
  })
})
