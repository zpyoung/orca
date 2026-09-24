import { describe, expect, it, vi } from 'vitest'
import { getUnresolvedAttempts } from '../../shared/fork-heimdall/ledger-queries'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import type {
  WatcherCommandResult,
  WatcherOwnerFence,
  WatcherTarget
} from '../../shared/fork-heimdall/fleet-types'
import type { LedgerEntry } from '../../shared/fork-heimdall/ledger-types'
import { action, enrollmentInput, harness, kind } from './kernel-service-test-harness'
import type { LeaseResult } from './lease-store'

vi.mock('electron', () => ({}))

/** A running attempt matching `action('revision-1')`'s fingerprint, so the gate holds forever. */
function inFlightAttempt(watcherId: string): LedgerEntry[] {
  const fingerprint = makeAttemptFingerprint('revision-1', 'apply-review-fix', 'review:revision-1')
  const attempted: LedgerEntry = {
    eventId: 'attempt-event',
    watcherId,
    atMs: 10,
    origin: 'owner',
    class: 'fact',
    kind: 'attempt',
    attemptId: 'attempt-1',
    fingerprint,
    action: action('revision-1'),
    state: 'attempted',
    dispatch: { spec: 'Do the work', dispatchKind: 'child' },
    orchestrationRequestId: 'request-1'
  }
  return [
    attempted,
    { ...attempted, eventId: 'running-event', atMs: 11, state: 'running', dispatchId: 'dispatch-1' }
  ]
}

describe('lease-refused status', () => {
  it('publishes a truthful lease-refused status while retrying', async () => {
    const world = await harness({
      lease: (): LeaseResult => ({
        status: 'refused',
        reason: 'held-by-other',
        holder: 'other-host',
        epoch: 7
      })
    })
    world.service.registerKind(kind())
    const result = await world.service.enroll(enrollmentInput())
    if (result.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const watcherId = result.entry.enrollment.watcherId
    world.schedule.mockClear()
    await world.service.reconcileForTesting(watcherId)

    expect((await world.service.list())[0]).toMatchObject({
      enrollment: { enabled: true },
      status: { phase: 'lease-refused', reason: 'Lease held by other-host (epoch 7)' }
    })
    expect(world.schedule).toHaveBeenCalled()
  })

  it('recomputes the published status from the durable enrollment, not the runner cache', async () => {
    const world = await harness({
      lease: (): LeaseResult => ({
        status: 'refused',
        reason: 'held-by-other',
        holder: 'other-host',
        epoch: 7
      })
    })
    world.service.registerKind(kind())
    const result = await world.service.enroll(enrollmentInput())
    if (result.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const watcherId = result.entry.enrollment.watcherId

    // simulates another owner disabling the watcher directly in the store while this
    // runner still holds the pre-disable enrollment in memory
    world.enrollmentStore.setEnabled(watcherId, false)

    world.schedule.mockClear()
    await world.service.reconcileForTesting(watcherId)

    expect((await world.service.list())[0]).toMatchObject({
      enrollment: { enabled: false },
      status: {
        phase: 'lease-refused',
        state: 'disabled',
        reason: 'Lease held by other-host (epoch 7)'
      }
    })
  })
})

describe('gate-hold pacing', () => {
  it('ramps the reschedule delay across repeated gate holds, not a flat rapid tier', async () => {
    const world = await harness()
    world.service.registerKind(
      kind({
        decide: () => ({ action: action('revision-1') }),
        pacing: { pace: () => 'rapid' }
      })
    )
    const result = await world.service.enroll(enrollmentInput())
    if (result.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const watcherId = result.entry.enrollment.watcherId
    for (const entry of inFlightAttempt(watcherId)) {
      world.ledgerStore.append(entry)
    }

    const delays: number[] = []
    for (let tickIndex = 0; tickIndex < 3; tickIndex += 1) {
      world.schedule.mockClear()
      await world.service.reconcileForTesting(watcherId)
      delays.push(world.schedule.mock.calls.at(-1)?.[1] as number)
    }

    expect(delays[1]).toBeGreaterThan(delays[0]!)
    expect(delays[2]).toBeGreaterThan(delays[1]!)
  })

  it('resets the gate-hold counter on the next successful tick', async () => {
    let proposeAction = true
    const world = await harness()
    world.service.registerKind(
      kind({
        decide: () =>
          proposeAction
            ? { action: action('revision-1') }
            : { action: null, reason: 'quiet', considered: [] },
        pacing: { pace: () => 'rapid' }
      })
    )
    const result = await world.service.enroll(enrollmentInput())
    if (result.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const watcherId = result.entry.enrollment.watcherId
    for (const entry of inFlightAttempt(watcherId)) {
      world.ledgerStore.append(entry)
    }

    // build up a multi-hold backoff before proving a success wipes it
    await world.service.reconcileForTesting(watcherId)
    await world.service.reconcileForTesting(watcherId)

    proposeAction = false
    await world.service.reconcileForTesting(watcherId)
    expect((await world.service.list())[0]).toMatchObject({ status: { state: 'watching' } })

    proposeAction = true
    world.schedule.mockClear()
    await world.service.reconcileForTesting(watcherId)
    expect(world.schedule.mock.calls.at(-1)?.[1]).toBe(30_000)
  })

  it('does not increment the gate-hold counter when execution is later blocked', async () => {
    let assertHeldCalls = 0
    let target: WatcherTarget | null = null
    let ownerFence: WatcherOwnerFence | null = null
    let pauseResult: Promise<WatcherCommandResult> | null = null
    const customLease = (): LeaseResult => ({
      status: 'held',
      epoch: 1,
      guard: {
        epoch: 1,
        holder: 'test-holder',
        assertHeld: async () => {
          assertHeldCalls += 1
          // 4th call = execute()'s own lease check, after runner-loop's snapshot check,
          // reconcileWorkers' mailbox-drain check, and gating's check have already passed
          if (assertHeldCalls === 4 && target && ownerFence) {
            pauseResult = world.service.command({
              target,
              expectedOwner: ownerFence,
              command: { kind: 'pause' }
            })
            // the pause is queued behind this watcher's per-command chain, so give its
            // synchronous control-flag flip room to land before this lease check resolves
            await Promise.resolve()
            await Promise.resolve()
            await Promise.resolve()
          }
        },
        renewLoop: () => ({ dispose: () => {} })
      }
    })
    const world = await harness({ lease: customLease })
    world.service.registerKind(
      kind({
        decide: () => ({ action: action('revision-1') }),
        pacing: { pace: () => 'rapid' }
      })
    )
    const result = await world.service.enroll(enrollmentInput())
    if (result.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const watcherId = result.entry.enrollment.watcherId
    const fleetEntry = (await world.service.fleet()).entries[0]!
    target = fleetEntry.target
    ownerFence = fleetEntry.ownerFence

    world.schedule.mockClear()
    await world.service.reconcileForTesting(watcherId)
    await pauseResult

    // a fresh action attempt was never appended, since executionAllowed flipped before it landed
    expect(
      world.ledgerStore.read(watcherId).entries.some((entry) => entry.kind === 'attempt')
    ).toBe(false)
    // the gate itself allowed the action; execution was blocked afterward, not by the gate
    const raceTick = (await world.service.debugReport(watcherId)).traces.at(-1)
    expect(raceTick).toMatchObject({ exitPath: 'gate-held', gate: { verdict: 'allow' } })

    // a paused watcher's refresh() returns before scheduling at all, so prove the counter is
    // untouched by resuming and forcing a real gate hold, rather than reading it while paused
    const paused = (await world.service.fleet()).entries[0]!
    await expect(
      world.service.command({
        target: paused.target,
        expectedOwner: paused.ownerFence,
        command: { kind: 'resume' }
      })
    ).resolves.toMatchObject({ status: 'applied' })
    for (const entry of inFlightAttempt(watcherId)) {
      world.ledgerStore.append(entry)
    }

    const delays: number[] = []
    for (let tickIndex = 0; tickIndex < 2; tickIndex += 1) {
      world.schedule.mockClear()
      await world.service.reconcileForTesting(watcherId)
      delays.push(world.schedule.mock.calls.at(-1)?.[1] as number)
    }
    // a residual increment from the race would start this ramp at 60s (consecutiveGateHolds=2)
    // instead of 30s (=1)
    expect(delays[0]).toBe(30_000)
    expect(delays[1]).toBe(60_000)
  })
})

describe('uncertain attempt recovery before stop predicates', () => {
  for (const effect of ['landed', 'indeterminate'] as const) {
    it(`${effect === 'landed' ? 'does not park' : 'parks'} after probing an aged uncertain attempt that is ${effect}`, async () => {
      const world = await harness()
      const resolveOutcome = vi.fn(() => ({ effect }))
      world.service.registerKind(
        kind({
          resolveOutcome,
          stopPredicates: [
            {
              id: 'uncertain-attempt-stuck',
              evaluate: (_snapshot, ledger) =>
                getUnresolvedAttempts(ledger).length > 0
                  ? { stop: true, reason: 'uncertain attempt remained stuck' }
                  : { stop: false }
            }
          ]
        })
      )
      const result = await world.service.enroll(
        enrollmentInput({ wallClockActiveMs: 100_000, turns: 100 })
      )
      if (result.status !== 'enrolled') {
        throw new Error('expected enrollment')
      }
      const watcherId = result.entry.enrollment.watcherId
      world.ledgerStore.append({
        eventId: 'uncertain-attempt',
        watcherId,
        atMs: 10,
        origin: 'owner',
        class: 'fact',
        kind: 'attempt',
        attemptId: 'uncertain-1',
        fingerprint: makeAttemptFingerprint('revision-1', 'apply-review-fix', 'review:revision-1'),
        action: action('revision-1'),
        state: 'settled',
        effect: 'indeterminate',
        reason: 'review-state-unknown'
      })

      await world.service.reconcileForTesting(watcherId)

      expect(resolveOutcome).toHaveBeenCalledTimes(1)
      expect((await world.service.fleet()).entries[0]?.entry.status.state).toBe(
        effect === 'landed' ? 'watching' : 'parked'
      )
      expect(
        world.ledgerStore
          .read(watcherId)
          .entries.some(
            (entry) =>
              entry.kind === 'attempt-resolved' &&
              entry.attemptId === 'uncertain-1' &&
              entry.effect === 'landed'
          )
      ).toBe(effect === 'landed')
    })
  }
})
