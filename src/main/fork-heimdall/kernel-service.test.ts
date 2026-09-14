import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { KernelAction, WatcherKind } from '../../shared/fork-heimdall/kind-contract'
import type { LedgerEntry } from '../../shared/fork-heimdall/ledger-types'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import type { EnrollInput, WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { HeimdallBudgetClock } from './budget-clock'
import { HeimdallDatabase } from './database'
import { HeimdallEnrollmentStore } from './enrollment-store'
import { HeimdallKernelServiceImpl } from './kernel-service'
import { HeimdallLedgerStore } from './ledger-store'
import type { LeaseResult, LeaseStore } from './lease-store'
import type { HeimdallOrchestrationAdapter } from './orchestration/orchestration-adapter'

vi.mock('electron', () => ({}))

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

type World = { revision: string; stopped?: boolean }
const action = (revision: string): KernelAction => ({
  kind: 'apply-review-fix',
  capability: 'write',
  visibility: 'external',
  contentIdentity: revision,
  evidenceKey: `review:${revision}`,
  expectedState: { target: 'review', before: revision }
})

const enrollmentInput = (budget = { wallClockActiveMs: 100, turns: 2 }): EnrollInput => ({
  kind: 'hosted-review',
  repoId: 'repo-1',
  worktreeId: 'worktree-1',
  capabilities: { write: 'on' },
  budget,
  kindPayload: { label: 'Review 1' }
})

function authorized(
  input: EnrollInput,
  owner: WatcherEnrollment['schedulerOwner'] = 'local_host_service'
) {
  return {
    kind: input.kind,
    workspaceKey: 'local::/workspace/review-1' as const,
    executionHostId: 'local' as const,
    repoId: input.repoId,
    worktreeId: input.worktreeId,
    workspacePath: '/workspace/review-1',
    schedulerOwner: owner,
    capabilities: input.capabilities,
    budget: input.budget,
    kindPayload: input.kindPayload
  }
}

function kind(overrides: Partial<WatcherKind<World, KernelAction, { label: string }>> = {}) {
  const defaultSnapshot: Snapshot<World> = {
    freshness: 'live',
    contentIdentity: 'revision-1',
    observedAtMs: 1,
    world: { revision: 'revision-1' }
  }
  return {
    id: 'hosted-review',
    displayName: 'Hosted review',
    describeEnrollment: () => 'Review 1',
    enrollmentPayloadSchema: z.object({ label: z.string() }).strict(),
    authorizeEnrollment: async (input: EnrollInput) => authorized(input),
    read: async () => defaultSnapshot,
    describeSnapshot: (snapshot: Snapshot<World>) => ({
      freshness: snapshot.freshness,
      contentIdentity: snapshot.contentIdentity,
      summary: snapshot.world.revision
    }),
    decide: () => ({ action: null, reason: 'quiet', considered: [] }),
    execute: async () => ({ effect: 'landed' as const }),
    resolveOutcome: () => 'not-landed' as const,
    ...overrides
  } satisfies WatcherKind<World, KernelAction, { label: string }>
}

function heldLease(): LeaseResult {
  return {
    status: 'held',
    epoch: 1,
    guard: {
      epoch: 1,
      assertHeld: async () => {},
      renewLoop: () => ({ dispose: () => {} })
    }
  }
}

async function harness(
  options: {
    lease?: () => LeaseResult
    mailbox?: () => LedgerEntry[]
    dispatchObservation?: () => { status: 'live' | 'exited' | 'unverifiable'; reason?: string }
  } = {}
) {
  const directory = await mkdtemp(join(tmpdir(), 'heimdall-kernel-'))
  directories.push(directory)
  const database = new HeimdallDatabase(directory)
  const enrollmentStore = new HeimdallEnrollmentStore(database)
  const ledgerStore = new HeimdallLedgerStore(database)
  const budgetClock = new HeimdallBudgetClock(ledgerStore, { now: () => 100 })
  const schedule = vi.fn()
  let identifier = 0
  const leaseStore: LeaseStore = {
    acquireOrRenew: vi.fn(async () => options.lease?.() ?? heldLease()),
    release: vi.fn(async () => {})
  }
  const orchestration: HeimdallOrchestrationAdapter = {
    ensureRun: vi.fn(async () => ({ runId: 'run-1' })),
    dispatchWorker: vi.fn(async () => ({
      status: 'dispatched' as const,
      dispatchId: 'dispatch-1'
    })),
    recoverDispatch: vi.fn(async () => ({ status: 'absent' as const })),
    readDispatch: vi.fn(async () => options.dispatchObservation?.() ?? { status: 'live' as const }),
    drainMailbox: vi.fn(async () => options.mailbox?.() ?? []),
    answerQuestion: vi.fn(async () => {})
  }
  const store = {
    getProfileStorageDirectory: () => directory,
    getSettings: () => ({ notifications: { enabled: false } })
  } as unknown as Store
  const service = new HeimdallKernelServiceImpl({
    runtime: {} as OrcaRuntimeService,
    store,
    database,
    enrollmentStore,
    ledgerStore,
    budgetClock,
    leaseStore,
    orchestration,
    now: () => 100,
    createId: () => `id-${++identifier}`,
    setTimer: ((callback: () => void, delay: number) => {
      schedule(callback, delay)
      return { unref: () => {} } as NodeJS.Timeout
    }) as typeof setTimeout,
    clearTimer: vi.fn() as unknown as typeof clearTimeout,
    holderId: 'test-holder'
  })
  return {
    service,
    database,
    enrollmentStore,
    ledgerStore,
    budgetClock,
    leaseStore,
    orchestration,
    schedule
  }
}

function runningDispatch(watcherId: string): LedgerEntry[] {
  const attempted: LedgerEntry = {
    eventId: 'attempt-event',
    watcherId,
    atMs: 10,
    origin: 'owner',
    class: 'fact',
    kind: 'attempt',
    attemptId: 'attempt-1',
    fingerprint: 'fingerprint-1',
    action: action('revision-1'),
    state: 'attempted',
    dispatch: { spec: 'Do the work', dispatchKind: 'child' },
    orchestrationRequestId: 'request-1'
  }
  return [
    attempted,
    {
      ...attempted,
      eventId: 'running-event',
      atMs: 11,
      state: 'running',
      dispatchId: 'dispatch-1'
    }
  ]
}

describe('Heimdall kernel service', () => {
  it('refuses duplicate workspaces and remote-host-owned enrollment without mutating a second row', async () => {
    const { service } = await harness()
    service.registerKind(kind())
    const first = await service.enroll(enrollmentInput())
    expect(first.status).toBe('enrolled')
    await expect(service.enroll(enrollmentInput())).resolves.toMatchObject({
      status: 'refused',
      reason: 'duplicate-workspace'
    })

    const remote = kind({
      id: 'objective',
      authorizeEnrollment: async (input) => ({
        ...authorized({ ...input, kind: 'hosted-review' }, 'remote_host_service'),
        kind: 'objective'
      })
    }) as unknown as WatcherKind<World, KernelAction, { label: string }>
    service.registerKind(remote)
    await expect(
      service.enroll({ ...enrollmentInput(), kind: 'objective', repoId: 'repo-2' })
    ).resolves.toEqual({
      status: 'refused',
      reason: 'owner-not-executable',
      schedulerOwner: 'remote_host_service'
    })
    expect(await service.list()).toHaveLength(1)
  })

  it('re-arms a disabled watcher by adding the new allowance to already spent budget', async () => {
    const { service, ledgerStore } = await harness()
    service.registerKind(kind())
    const result = await service.enroll(enrollmentInput())
    if (result.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const watcherId = result.entry.enrollment.watcherId
    ledgerStore.append({
      eventId: 'open',
      watcherId,
      atMs: 0,
      origin: 'owner',
      class: 'fact',
      kind: 'interval-open',
      intervalId: 'interval-1',
      cause: 'action-in-flight'
    })
    ledgerStore.append({
      eventId: 'close',
      watcherId,
      atMs: 40,
      origin: 'owner',
      class: 'fact',
      kind: 'interval-close',
      intervalId: 'interval-1',
      closeReason: 'settled'
    })
    ledgerStore.append({
      eventId: 'turn',
      watcherId,
      atMs: 40,
      origin: 'owner',
      class: 'fact',
      kind: 'turn',
      dispatchKind: 'child',
      dispatchId: 'dispatch-old'
    })
    await service.disarm(watcherId)
    const rearmed = await service.enroll({
      ...enrollmentInput(),
      capabilities: { write: 'gated' },
      kindPayload: { label: 'Review 1 updated' }
    })
    expect(rearmed.status).toBe('re-armed')
    if (rearmed.status === 're-armed') {
      expect(rearmed.entry.enrollment.budget).toEqual({ wallClockActiveMs: 140, turns: 3 })
      expect(rearmed.entry.enrollment.capabilities).toEqual({ write: 'gated' })
      expect(rearmed.entry.enrollment.kindPayload).toEqual({ label: 'Review 1 updated' })
    }
  })

  it('retains enrollment and retries when lease acquisition is refused', async () => {
    const { service, schedule } = await harness({
      lease: () => ({ status: 'refused', reason: 'held-by-other', holder: 'other', epoch: 7 })
    })
    service.registerKind(kind())
    const result = await service.enroll(enrollmentInput())
    if (result.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    schedule.mockClear()
    await service.reconcileForTesting(result.entry.enrollment.watcherId)
    expect((await service.list())[0]?.enrollment.enabled).toBe(true)
    expect(schedule).toHaveBeenCalled()
  })

  it('re-reads live before external action and abandons a cached decision when identity moves', async () => {
    const reads: boolean[] = []
    let pulse = 0
    const execute = vi.fn(async () => ({ effect: 'landed' as const }))
    const snapshots: Snapshot<World>[] = [
      { freshness: 'live', contentIdentity: 'base', observedAtMs: 1, world: { revision: 'base' } },
      { freshness: 'cached', contentIdentity: 'old', observedAtMs: 2, world: { revision: 'old' } },
      { freshness: 'live', contentIdentity: 'new', observedAtMs: 3, world: { revision: 'new' } }
    ]
    const { service } = await harness()
    service.registerKind(
      kind({
        read: async (_enrollment, options) => {
          reads.push(options.fresh)
          return snapshots.shift()!
        },
        decide: (snapshot) => {
          pulse++
          if (pulse === 1) {
            return { action: null, reason: 'initial', considered: [] }
          }
          return { action: action(snapshot.contentIdentity) }
        },
        execute
      })
    )
    const result = await service.enroll(enrollmentInput())
    if (result.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    await service.reconcileForTesting(result.entry.enrollment.watcherId)
    await service.reconcileForTesting(result.entry.enrollment.watcherId)
    expect(reads).toEqual([true, false, true])
    expect(execute).not.toHaveBeenCalled()
    expect(service.ledger(result.entry.enrollment.watcherId).entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'attempt-abandoned', reason: 'workspace-moved' })
      ])
    )
  })

  it('parks on a stop predicate but keeps transient read failures enrolled with backoff', async () => {
    const stopped = await harness()
    stopped.service.registerKind(
      kind({
        read: async () => ({
          freshness: 'live',
          contentIdentity: 'stop',
          observedAtMs: 1,
          world: { revision: 'stop', stopped: true }
        }),
        stopPredicates: [
          {
            id: 'closed',
            evaluate: (snapshot) =>
              snapshot.world.stopped ? { stop: true, reason: 'review-closed' } : { stop: false }
          }
        ]
      })
    )
    const enrolled = await stopped.service.enroll(enrollmentInput())
    if (enrolled.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    await stopped.service.reconcileForTesting(enrolled.entry.enrollment.watcherId)
    expect((await stopped.service.list())[0]).toMatchObject({
      enrollment: { enabled: false },
      status: { state: 'parked', parkReason: { kind: 'stop-predicate', predicateId: 'closed' } }
    })

    const failing = await harness()
    failing.service.registerKind(
      kind({
        read: async () => {
          throw new Error('host offline')
        }
      })
    )
    const failingEnrollment = await failing.service.enroll(enrollmentInput())
    if (failingEnrollment.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    failing.schedule.mockClear()
    await failing.service.reconcileForTesting(failingEnrollment.entry.enrollment.watcherId)
    expect((await failing.service.list())[0]).toMatchObject({
      enrollment: { enabled: true },
      status: { state: 'unreachable', reason: 'host offline' }
    })
    expect(failing.schedule).toHaveBeenCalled()
  })

  it('settles on worker_done even while a worker process is live', async () => {
    let watcherId = ''
    const { service, ledgerStore, budgetClock, orchestration } = await harness({
      mailbox: () => [
        {
          eventId: 'mail-done',
          watcherId,
          atMs: 20,
          origin: 'owner',
          class: 'fact',
          kind: 'evidence',
          evidenceKind: 'orchestration-mailbox',
          source: {
            kind: 'orchestration',
            sequence: 1,
            messageId: 'message-done',
            deliveryId: 'delivery-1'
          },
          payload: {
            type: 'worker_done',
            body: 'complete',
            payload: JSON.stringify({ dispatchId: 'dispatch-1', outcome: 'succeeded' })
          }
        }
      ]
    })
    service.registerKind(kind())
    const result = await service.enroll(enrollmentInput())
    if (result.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    watcherId = result.entry.enrollment.watcherId
    for (const entry of runningDispatch(watcherId)) {
      ledgerStore.append(entry)
    }
    budgetClock.open(watcherId, 'worker-dispatched')
    await service.reconcileForTesting(watcherId)
    expect(budgetClock.current(watcherId)).toBeNull()
    expect(orchestration.readDispatch).not.toHaveBeenCalled()
    expect(service.ledger(watcherId).entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'attempt', state: 'settled', effect: 'landed' })
      ])
    )
  })

  it('parks a worker question, records its message id, and pauses budget without losing dispatch identity', async () => {
    let watcherId = ''
    const { service, ledgerStore, budgetClock, orchestration } = await harness({
      mailbox: () => [
        {
          eventId: 'mail-question',
          watcherId,
          atMs: 20,
          origin: 'owner',
          class: 'fact',
          kind: 'evidence',
          evidenceKind: 'orchestration-mailbox',
          source: {
            kind: 'orchestration',
            sequence: 1,
            messageId: 'message-question',
            deliveryId: 'delivery-1'
          },
          payload: {
            type: 'question',
            body: 'Which branch?',
            payload: JSON.stringify({ dispatchId: 'dispatch-1' })
          }
        }
      ]
    })
    service.registerKind(kind())
    const result = await service.enroll(enrollmentInput())
    if (result.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    watcherId = result.entry.enrollment.watcherId
    for (const entry of runningDispatch(watcherId)) {
      ledgerStore.append(entry)
    }
    budgetClock.open(watcherId, 'worker-dispatched')
    await service.reconcileForTesting(watcherId)
    expect(budgetClock.current(watcherId)).toBeNull()
    expect(orchestration.readDispatch).not.toHaveBeenCalled()
    expect((await service.list())[0]).toMatchObject({
      status: {
        state: 'parked',
        parkReason: { kind: 'worker-question', messageId: 'message-question' }
      }
    })
    expect(service.ledger(watcherId).entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'attempt', state: 'running', dispatchId: 'dispatch-1' }),
        expect.objectContaining({
          kind: 'escalation',
          escalationKind: 'worker-question',
          reason: expect.stringContaining('message-question')
        })
      ])
    )
  })
  it('keeps polling after a disarm that leaves work in flight so the lease is released', async () => {
    const { service, ledgerStore, leaseStore, schedule } = await harness()
    service.registerKind(kind())
    const result = await service.enroll(enrollmentInput({ wallClockActiveMs: 100_000, turns: 100 }))
    if (result.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const watcherId = result.entry.enrollment.watcherId
    for (const entry of runningDispatch(watcherId)) {
      ledgerStore.append(entry)
    }

    await service.disarm(watcherId)
    // the in-flight branch deliberately holds the lease so the worker can still be reconciled
    expect(leaseStore.release).not.toHaveBeenCalled()
    expect((await service.list())[0]).toMatchObject({
      status: { enabled: false, state: 'disabled', phase: 'disarmed' }
    })

    schedule.mockClear()
    await service.reconcileForTesting(watcherId)
    expect(schedule).toHaveBeenCalled()
  })
  it('honors explicit not-landed executor evidence but pins an untyped throw as indeterminate', async () => {
    const run = async (thrown: unknown) => {
      const { service } = await harness()
      service.registerKind(
        kind({
          decide: (snapshot) => ({ action: action(snapshot.contentIdentity) }),
          execute: async () => {
            throw thrown
          }
        })
      )
      const result = await service.enroll(enrollmentInput())
      if (result.status !== 'enrolled') {
        throw new Error('expected enrollment')
      }
      await service.reconcileForTesting(result.entry.enrollment.watcherId)
      return service
        .ledger(result.entry.enrollment.watcherId)
        .entries.findLast((entry) => entry.kind === 'attempt' && entry.state === 'settled')
    }

    await expect(
      run({ effect: 'not-landed', reason: 'precondition-refused' })
    ).resolves.toMatchObject({
      effect: 'not-landed',
      reason: 'precondition-refused'
    })
    await expect(run(new Error('transport reset'))).resolves.toMatchObject({
      effect: 'indeterminate',
      reason: 'transport reset'
    })
  })

  it('does not settle an attempt twice when dispatch and executor report the same outcome', async () => {
    const outcomes = [
      {
        dispatch: {
          status: 'refused' as const,
          reason: 'placement-unavailable' as const,
          detail: 'workspace unavailable'
        },
        effect: 'not-landed'
      },
      {
        dispatch: {
          status: 'indeterminate' as const,
          requestId: 'heimdall-request'
        },
        effect: 'indeterminate'
      }
    ]
    for (const expected of outcomes) {
      const { service, orchestration } = await harness()
      orchestration.dispatchWorker = vi.fn(async () => expected.dispatch)
      service.registerKind(
        kind({
          decide: (snapshot) => ({ action: action(snapshot.contentIdentity) }),
          execute: async (_action, context) => {
            const result = await context.dispatchWorker({ spec: 'Fix the review.' })
            return result.status === 'refused'
              ? { effect: 'not-landed' as const, reason: result.reason }
              : { effect: 'indeterminate' as const, reason: 'operation-unknown' }
          }
        })
      )
      const result = await service.enroll(enrollmentInput())
      if (result.status !== 'enrolled') {
        throw new Error('expected enrollment')
      }

      await service.reconcileForTesting(result.entry.enrollment.watcherId)

      const settled = service
        .ledger(result.entry.enrollment.watcherId)
        .entries.filter(
          (entry): entry is Extract<LedgerEntry, { kind: 'attempt' }> =>
            entry.kind === 'attempt' && entry.state === 'settled'
        )
      expect(settled).toHaveLength(1)
      expect(settled.find((entry) => entry.effect === expected.effect)).toMatchObject({
        effect: expected.effect
      })
    }
  })

  it('retries an absent write-ahead receipt only after a fresh gated re-decision', async () => {
    const { service, orchestration } = await harness()
    orchestration.dispatchWorker = vi
      .fn()
      .mockRejectedValueOnce(new Error('crash before receipt'))
      .mockResolvedValueOnce({ status: 'dispatched', dispatchId: 'dispatch-recovered' })
    orchestration.recoverDispatch = vi.fn(async () => ({ status: 'absent' as const }))
    service.registerKind(
      kind({
        decide: (snapshot) => ({ action: action(snapshot.contentIdentity) }),
        execute: async (_action, context) => {
          const result = await context.dispatchWorker({ spec: 'Fix the review.' })
          return result.status === 'dispatched'
            ? { effect: 'landed' as const }
            : { effect: 'indeterminate' as const, reason: 'dispatch-not-confirmed' }
        }
      })
    )
    const result = await service.enroll(enrollmentInput())
    if (result.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const watcherId = result.entry.enrollment.watcherId

    await service.reconcileForTesting(watcherId)
    await service.reconcileForTesting(watcherId)

    expect(orchestration.recoverDispatch).toHaveBeenCalledOnce()
    expect(orchestration.dispatchWorker).toHaveBeenCalledTimes(2)
    const attempts = service.ledger(watcherId).entries.filter((entry) => entry.kind === 'attempt')
    expect(new Set(attempts.map((attempt) => attempt.attemptId)).size).toBe(1)
    expect(attempts).toContainEqual(
      expect.objectContaining({
        state: 'running',
        dispatchId: 'dispatch-recovered'
      })
    )
    expect(service.ledger(watcherId).entries.filter((entry) => entry.kind === 'turn')).toHaveLength(
      1
    )
  })

  it('quarantines malformed persisted payload JSON without blocking valid watchers', async () => {
    const { service, database, enrollmentStore } = await harness()
    const base = {
      ...authorized(enrollmentInput()),
      enabled: true,
      coordinatorIdentity: { handle: 'coordinator', paneKey: 'pane' },
      orchestrationRunId: null,
      createdAtMs: 1,
      terminalAtMs: null
    }
    enrollmentStore.insert({ ...base, watcherId: 'malformed-watcher' })
    enrollmentStore.insert({
      ...base,
      watcherId: 'valid-watcher',
      workspaceKey: 'local::/workspace/review-2',
      worktreeId: 'worktree-2',
      workspacePath: '/workspace/review-2'
    })
    const rawPayload = '{"label":"truncated"'
    database
      .connection()
      .prepare('UPDATE heimdall_enrollment SET kind_payload_json = ? WHERE watcher_id = ?')
      .run(rawPayload, 'malformed-watcher')
    const read = vi.fn(kind().read)
    service.registerKind(kind({ read }))

    const listed = await service.list()
    await service.reconcileForTesting('valid-watcher')

    expect(listed).toHaveLength(2)
    expect(
      listed.find((entry) => entry.enrollment.watcherId === 'malformed-watcher')
    ).toMatchObject({
      enrollment: { kindPayload: rawPayload },
      status: {
        enabled: false,
        state: 'escalated',
        phase: 'invalid-kind-payload'
      }
    })
    expect(
      service
        .ledger('malformed-watcher')
        .entries.filter(
          (entry) => entry.kind === 'escalation' && entry.escalationKind === 'invalid-kind-payload'
        )
    ).toHaveLength(1)
    expect(read).toHaveBeenCalled()
    expect(
      database
        .connection()
        .prepare('SELECT kind_payload_json FROM heimdall_enrollment WHERE watcher_id = ?')
        .get('malformed-watcher')
    ).toEqual({ kind_payload_json: rawPayload })
  })

  it('revalidates enrollment and lease after preflight before committing an action', async () => {
    let enterPreflight!: () => void
    const enteredPreflight = new Promise<void>((resolve) => {
      enterPreflight = resolve
    })
    let finishPreflight!: () => void
    const preflightFinished = new Promise<void>((resolve) => {
      finishPreflight = resolve
    })
    const execute = vi.fn(async () => ({ effect: 'landed' as const }))
    const { service, leaseStore } = await harness()
    service.registerKind(
      kind({
        decide: (snapshot) => ({ action: action(snapshot.contentIdentity) }),
        preflight: async () => {
          enterPreflight()
          await preflightFinished
          return { verdict: 'allow' as const }
        },
        execute
      })
    )
    const result = await service.enroll(enrollmentInput())
    if (result.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const watcherId = result.entry.enrollment.watcherId

    const reconciliation = service.reconcileForTesting(watcherId)
    await enteredPreflight
    await service.disarm(watcherId)
    finishPreflight()
    await reconciliation

    expect(execute).not.toHaveBeenCalled()
    expect(leaseStore.release).toHaveBeenCalled()
    expect(service.ledger(watcherId).entries.some((entry) => entry.kind === 'attempt')).toBe(false)
  })
})
