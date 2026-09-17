import { describe, expect, it, vi } from 'vitest'
import { HEIMDALL_BUDGET_GENERATION_EVIDENCE_KIND } from '../../shared/fork-heimdall/budget'
import type { KernelAction, WatcherKind } from '../../shared/fork-heimdall/kind-contract'
import type { LedgerEntry } from '../../shared/fork-heimdall/ledger-types'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import { HeimdallDatabase } from './database'
import { HeimdallEnrollmentStore } from './enrollment-store'
import {
  action,
  authorized,
  enrollmentInput,
  harness,
  kind,
  runningDispatch,
  type World
} from './kernel-service-test-harness'

vi.mock('electron', () => ({}))

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

  it('starts a fresh budget generation when enrolling after explicit disarm', async () => {
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
    for (const entry of runningDispatch(watcherId)) {
      ledgerStore.append(entry)
    }
    const active = (await service.fleet()).entries.find(
      (entry) => entry.target.watcherId === watcherId
    )!
    await expect(
      service.command({
        target: active.target,
        expectedOwner: active.ownerFence,
        command: { kind: 'disarm' }
      })
    ).resolves.toMatchObject({ status: 'applied' })
    const rearmed = await service.enroll({
      ...enrollmentInput(),
      capabilities: { write: 'gated' },
      kindPayload: { label: 'Review 1 updated' }
    })
    expect(rearmed.status).toBe('re-armed')
    if (rearmed.status !== 're-armed') {
      throw new Error('expected re-armed enrollment')
    }
    expect(rearmed.entry.enrollment).toMatchObject({
      watcherId,
      budget: { wallClockActiveMs: 100, turns: 2 },
      capabilities: { write: 'gated' },
      kindPayload: { label: 'Review 1 updated' }
    })
    expect(rearmed.entry.status.budget).toEqual({ activeMs: 0, turns: 0, exhausted: null })
    expect(service.ledger(watcherId).entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventId: 'open', kind: 'interval-open' }),
        expect.objectContaining({ eventId: 'close', kind: 'interval-close' }),
        expect.objectContaining({ eventId: 'turn', kind: 'turn' }),
        expect.objectContaining({ eventId: 'running-event', kind: 'attempt', state: 'running' }),
        expect.objectContaining({
          kind: 'evidence',
          evidenceKind: HEIMDALL_BUDGET_GENERATION_EVIDENCE_KIND,
          payload: { reason: 're-enrollment-after-explicit-disarm' }
        })
      ])
    )
    expect(
      service
        .ledger(watcherId)
        .entries.some((entry) => entry.kind === 'attempt-resolved' || entry.kind === 'terminal')
    ).toBe(false)

    ledgerStore.append({
      eventId: 'new-open',
      watcherId,
      atMs: 100,
      origin: 'owner',
      class: 'fact',
      kind: 'interval-open',
      intervalId: 'interval-2',
      cause: 'action-in-flight'
    })
    ledgerStore.append({
      eventId: 'new-close',
      watcherId,
      atMs: 125,
      origin: 'owner',
      class: 'fact',
      kind: 'interval-close',
      intervalId: 'interval-2',
      closeReason: 'settled'
    })
    ledgerStore.append({
      eventId: 'new-turn',
      watcherId,
      atMs: 125,
      origin: 'owner',
      class: 'fact',
      kind: 'turn',
      dispatchKind: 'child',
      dispatchId: 'dispatch-new'
    })
    expect((await service.fleet()).entries[0]?.entry.status.budget).toEqual({
      activeMs: 25,
      turns: 1,
      exhausted: null
    })
  })

  it('preserves consumed usage when re-enrolling an automatically parked watcher', async () => {
    const { service, ledgerStore } = await harness()
    service.registerKind(kind())
    const enrolled = await service.enroll(enrollmentInput({ wallClockActiveMs: null, turns: 1 }))
    if (enrolled.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const watcherId = enrolled.entry.enrollment.watcherId
    ledgerStore.append({
      eventId: 'spent-turn',
      watcherId,
      atMs: 50,
      origin: 'owner',
      class: 'fact',
      kind: 'turn',
      dispatchKind: 'child',
      dispatchId: 'spent-dispatch'
    })
    await service.reconcileForTesting(watcherId)

    const rearmed = await service.enroll(enrollmentInput())
    expect(rearmed.status).toBe('re-armed')
    if (rearmed.status !== 're-armed') {
      throw new Error('expected re-armed enrollment')
    }
    expect(rearmed.entry.enrollment.budget).toEqual({ wallClockActiveMs: 100, turns: 3 })
    expect(rearmed.entry.status.budget).toEqual({ activeMs: 0, turns: 1, exhausted: null })
    expect(
      service
        .ledger(watcherId)
        .entries.some(
          (entry) =>
            entry.kind === 'evidence' &&
            entry.evidenceKind === HEIMDALL_BUDGET_GENERATION_EVIDENCE_KIND
        )
    ).toBe(false)
  })

  it('refuses cross-authority rearm without transferring a disabled watcher', async () => {
    const desktop = await harness()
    desktop.service.registerKind(kind())
    const enrolled = await desktop.service.enroll(enrollmentInput())
    if (enrolled.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const active = (await desktop.service.fleet()).entries[0]!
    await expect(
      desktop.service.command({
        target: active.target,
        expectedOwner: active.ownerFence,
        command: { kind: 'disarm' }
      })
    ).resolves.toMatchObject({ status: 'applied' })
    await desktop.service.stopForShutdown()

    const runtime = await harness({
      directory: desktop.directory,
      storageAuthority: 'runtime'
    })
    runtime.service.registerKind(
      kind({
        authorizeEnrollment: async (input) => authorized(input, 'remote_host_service')
      })
    )
    await expect(runtime.service.enroll(enrollmentInput())).resolves.toEqual({
      status: 'refused',
      reason: 'owner-not-executable',
      schedulerOwner: 'local_host_service'
    })
    expect(runtime.enrollmentStore.get(enrolled.entry.enrollment.watcherId)).toMatchObject({
      enabled: false,
      schedulerOwner: 'local_host_service',
      commandRevision: 1
    })
    await runtime.service.stopForShutdown()
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
    const stoppedKind = kind({
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
    stopped.service.registerKind(stoppedKind)
    const enrolled = await stopped.service.enroll(enrollmentInput())
    if (enrolled.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    await stopped.service.reconcileForTesting(enrolled.entry.enrollment.watcherId)
    expect((await stopped.service.list())[0]).toMatchObject({
      enrollment: { enabled: false },
      status: { state: 'parked', parkReason: { kind: 'stop-predicate', predicateId: 'closed' } }
    })

    await stopped.service.stopForShutdown()
    const restarted = await harness({ directory: stopped.directory })
    restarted.service.registerKind(stoppedKind)
    const restoredPark = (await restarted.service.fleet()).entries[0]!
    expect(restoredPark).toMatchObject({
      entry: {
        enrollment: { enabled: false },
        status: {
          state: 'parked',
          phase: 'parked',
          reason: 'stop-predicate',
          parkReason: {
            kind: 'stop-predicate',
            predicateId: 'closed',
            reason: 'review-closed'
          }
        }
      }
    })
    await expect(
      restarted.service.command({
        target: restoredPark.target,
        expectedOwner: restoredPark.ownerFence,
        command: { kind: 'disarm' }
      })
    ).resolves.toMatchObject({ status: 'applied' })
    const disarmed = (await restarted.service.fleet()).entries[0]!
    expect(disarmed).toMatchObject({
      ownerFence: { revision: 1 },
      entry: { enrollment: { enabled: false }, status: { state: 'disabled' } }
    })
    await expect(
      restarted.service.command({
        target: disarmed.target,
        expectedOwner: disarmed.ownerFence,
        command: { kind: 'resume' }
      })
    ).resolves.toMatchObject({ status: 'refused', reason: 'invalid-state' })
    await restarted.service.stopForShutdown()

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
    const parkedEntry = (await service.fleet()).entries[0]!
    await expect(
      service.command({
        target: parkedEntry.target,
        expectedOwner: parkedEntry.ownerFence,
        command: {
          kind: 'answer-question',
          messageId: 'message-question',
          body: 'Use the current branch'
        }
      })
    ).resolves.toMatchObject({ status: 'applied' })
    expect(orchestration.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ watcherId }),
      'message-question',
      'Use the current branch'
    )
    await service.reconcileForTesting(watcherId)
    expect((await service.fleet()).entries[0]).toMatchObject({
      ownerFence: { revision: 1 },
      entry: { enrollment: { enabled: true }, status: { state: 'watching' } }
    })
    const latestQuestion = service
      .ledger(watcherId)
      .entries.findLast(
        (entry) => entry.kind === 'escalation' && entry.escalationKind === 'worker-question'
      )
    expect(latestQuestion).toMatchObject({ status: 'resolved' })
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

    const active = (await service.fleet()).entries[0]!
    await expect(
      service.command({
        target: active.target,
        expectedOwner: active.ownerFence,
        command: { kind: 'disarm' }
      })
    ).resolves.toMatchObject({ status: 'applied' })
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
      paused: false,
      commandRevision: 0,
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
    const malformedReport = await service.debugReport('malformed-watcher')

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
    expect(malformedReport).toMatchObject({
      malformedPayload: true,
      status: { state: 'escalated', phase: 'invalid-kind-payload' },
      runner: null,
      workers: [],
      workersError: null
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

  it('allocates strictly increasing fleet generations when the clock does not advance', async () => {
    const { service } = await harness()

    const first = await service.fleet()
    const second = await service.fleet()

    expect(first.generatedAtMs).toBe(100)
    expect(second.generatedAtMs).toBe(101)
  })

  it('fences an in-flight decision with a durable pause before its commit point', async () => {
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
    const row = (await service.fleet()).entries[0]!

    const reconciliation = service.reconcileForTesting(watcherId)
    await enteredPreflight
    const pause = service.command({
      target: row.target,
      expectedOwner: row.ownerFence,
      command: { kind: 'pause' }
    })
    await Promise.resolve()
    await Promise.resolve()
    finishPreflight()
    await reconciliation
    await expect(pause).resolves.toMatchObject({ status: 'applied' })

    expect(execute).not.toHaveBeenCalled()
    expect(leaseStore.release).toHaveBeenCalled()
    expect((await service.fleet()).entries[0]).toMatchObject({
      paused: true,
      ownerFence: { revision: 1 },
      entry: { enrollment: { enabled: true, budget: enrollmentInput().budget } }
    })
    expect(service.ledger(watcherId).entries.some((entry) => entry.kind === 'attempt')).toBe(false)
  })
  it('blocks worker dispatch when pause is requested at an async pre-dispatch boundary', async () => {
    let enterBoundary!: () => void
    const enteredBoundary = new Promise<void>((resolve) => {
      enterBoundary = resolve
    })
    let releaseBoundary!: () => void
    const boundaryReleased = new Promise<void>((resolve) => {
      releaseBoundary = resolve
    })
    const { service, orchestration, leaseStore } = await harness()
    leaseStore.describeLocation = () => ({
      executionHostId: 'local',
      leaseDirectory: '/workspace/review-1/.orca/heimdall/lease',
      pathSeparator: '/'
    })
    service.registerKind(
      kind({
        decide: (snapshot) => ({ action: action(snapshot.contentIdentity) }),
        execute: async (_action, context) => {
          enterBoundary()
          await boundaryReleased
          await context.lease.assertHeld()
          await context.dispatchWorker({ spec: 'must-not-dispatch' })
          return { effect: 'landed' as const }
        }
      })
    )
    const enrolled = await service.enroll(enrollmentInput())
    if (enrolled.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const row = (await service.fleet()).entries[0]!
    const reconciliation = service.reconcileForTesting(row.target.watcherId)
    await enteredBoundary
    const pause = service.command({
      target: row.target,
      expectedOwner: row.ownerFence,
      command: { kind: 'pause' }
    })
    await Promise.resolve()
    await Promise.resolve()
    const pendingReport = await service.debugReport(row.target.watcherId)
    expect(pendingReport).toMatchObject({
      pendingControlOperation: true,
      runner: { controlPending: 'pause', actionInFlight: true }
    })
    expect(pendingReport.pointers).toContainEqual({
      role: 'lease-holder',
      host: 'local',
      path: '/workspace/review-1/.orca/heimdall/lease/epoch-1/holder.json',
      status: 'resolved'
    })
    releaseBoundary()
    await reconciliation
    await expect(pause).resolves.toMatchObject({ status: 'applied' })

    expect(orchestration.dispatchWorker).not.toHaveBeenCalled()
    expect((await service.fleet()).entries[0]).toMatchObject({
      paused: true,
      entry: { status: { state: 'held', phase: 'paused' } }
    })
  })

  it('preserves consumed budget across pause, policy adjustment, and resume', async () => {
    const { service, ledgerStore } = await harness()
    service.registerKind(kind())
    const enrolled = await service.enroll(enrollmentInput())
    if (enrolled.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const watcherId = enrolled.entry.enrollment.watcherId
    ledgerStore.append({
      eventId: 'turn-1',
      watcherId,
      atMs: 100,
      origin: 'owner',
      class: 'fact',
      kind: 'turn',
      dispatchKind: 'planner',
      dispatchId: 'dispatch-1'
    })
    const initial = (await service.fleet()).entries[0]!
    await service.command({
      target: initial.target,
      expectedOwner: initial.ownerFence,
      command: { kind: 'pause' }
    })
    const paused = (await service.fleet()).entries[0]!
    await service.command({
      target: paused.target,
      expectedOwner: paused.ownerFence,
      command: {
        kind: 'adjust-budget',
        budget: { wallClockActiveMs: 120_000, turns: 8 }
      }
    })
    const adjusted = (await service.fleet()).entries[0]!

    expect(adjusted).toMatchObject({
      paused: true,
      ownerFence: { revision: 2 },
      entry: {
        enrollment: { budget: { wallClockActiveMs: 120_000, turns: 8 } },
        status: { budget: { turns: 1 } }
      }
    })
    await service.command({
      target: adjusted.target,
      expectedOwner: adjusted.ownerFence,
      command: { kind: 'resume' }
    })
    expect((await service.fleet()).entries[0]).toMatchObject({
      paused: false,
      ownerFence: { revision: 3 },
      entry: {
        enrollment: { budget: { wallClockActiveMs: 120_000, turns: 8 } },
        status: { budget: { turns: 1 } }
      }
    })
  })

  it('keeps an adjusted budget park durable until explicit resume', async () => {
    const parked = await harness()
    const registeredKind = kind()
    parked.service.registerKind(registeredKind)
    const enrolled = await parked.service.enroll(
      enrollmentInput({ wallClockActiveMs: null, turns: 1 })
    )
    if (enrolled.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const watcherId = enrolled.entry.enrollment.watcherId
    parked.ledgerStore.append({
      eventId: 'budget-turn',
      watcherId,
      atMs: 100,
      origin: 'owner',
      class: 'fact',
      kind: 'turn',
      dispatchKind: 'planner',
      dispatchId: 'budget-dispatch'
    })
    await parked.service.reconcileForTesting(watcherId)
    const exhausted = (await parked.service.fleet()).entries[0]!
    await expect(
      parked.service.command({
        target: exhausted.target,
        expectedOwner: exhausted.ownerFence,
        command: { kind: 'resume' }
      })
    ).resolves.toMatchObject({ status: 'refused', reason: 'invalid-state' })
    await parked.service.command({
      target: exhausted.target,
      expectedOwner: exhausted.ownerFence,
      command: {
        kind: 'adjust-budget',
        budget: { wallClockActiveMs: null, turns: 2 }
      }
    })
    await parked.service.stopForShutdown()

    const restarted = await harness({ directory: parked.directory })
    restarted.service.registerKind(registeredKind)
    const stillParked = (await restarted.service.fleet()).entries[0]!
    expect(stillParked).toMatchObject({
      ownerFence: { revision: 1 },
      entry: {
        enrollment: { enabled: false, budget: { wallClockActiveMs: null, turns: 2 } },
        status: {
          state: 'parked',
          parkReason: { kind: 'budget', exhaustion: { kind: 'turns' } },
          budget: { turns: 1, exhausted: null }
        }
      }
    })
    await expect(
      restarted.service.command({
        target: stillParked.target,
        expectedOwner: stillParked.ownerFence,
        command: { kind: 'resume' }
      })
    ).resolves.toMatchObject({ status: 'applied' })
    expect((await restarted.service.fleet()).entries[0]).toMatchObject({
      ownerFence: { revision: 2 },
      entry: { enrollment: { enabled: true }, status: { state: 'watching', phase: 'resumed' } }
    })
    await restarted.service.stopForShutdown()
  })

  it('retains pause across storage restart and refuses stale revision or owner fences', async () => {
    const { service, directory } = await harness()
    service.registerKind(kind())
    const enrolled = await service.enroll(enrollmentInput())
    if (enrolled.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const row = (await service.fleet()).entries[0]!
    await expect(
      service.command({
        target: row.target,
        expectedOwner: row.ownerFence,
        command: { kind: 'pause' }
      })
    ).resolves.toMatchObject({ status: 'applied' })
    await expect(
      service.command({
        target: row.target,
        expectedOwner: row.ownerFence,
        command: { kind: 'resume' }
      })
    ).resolves.toMatchObject({ status: 'refused', reason: 'stale-revision' })
    await expect(
      service.command({
        target: row.target,
        expectedOwner: { ...row.ownerFence, workspaceKey: 'local::/different-worktree' },
        command: { kind: 'resume' }
      })
    ).resolves.toMatchObject({ status: 'refused', reason: 'owner-conflict' })

    await service.stopForShutdown()
    const reopenedDatabase = new HeimdallDatabase(directory)
    const reopenedEnrollments = new HeimdallEnrollmentStore(reopenedDatabase)
    expect(reopenedEnrollments.get(row.target.watcherId)).toMatchObject({
      enabled: true,
      paused: true,
      commandRevision: 1,
      budget: enrollmentInput().budget
    })
    reopenedDatabase.close()
  })
})
