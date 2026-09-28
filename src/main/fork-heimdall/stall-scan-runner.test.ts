import { describe, expect, it, vi } from 'vitest'
import { getLatestEscalations } from '../../shared/fork-heimdall/ledger-queries'
import type { WorkerIdleObservation } from './orchestration/orchestration-contract'
import { OWNER_IDLE_GRACE_MS } from './owner/idle-worker-detector'
import { WORKER_IDLE_OBSERVATION } from './stall-scan'
import { enrollmentInput, harness, kind, runningDispatch } from './kernel-service-test-harness'

vi.mock('electron', () => ({}))

const IDLE_SINCE_MS = 1_000_000

async function idleWorld(lastMessage: string, nowMs = IDLE_SINCE_MS + OWNER_IDLE_GRACE_MS) {
  const idle: WorkerIdleObservation = {
    status: 'idle',
    activity: 'waiting',
    idleSinceMs: IDLE_SINCE_MS,
    lastMessage: { text: lastMessage, truncated: false }
  }
  const world = await harness({ idleObservation: async () => idle, now: () => nowMs })
  world.service.registerKind(kind())
  const result = await world.service.enroll(
    enrollmentInput({ wallClockActiveMs: 100_000_000, turns: 100 })
  )
  if (result.status !== 'enrolled') {
    throw new Error('expected enrollment')
  }
  const watcherId = result.entry.enrollment.watcherId
  for (const entry of runningDispatch(watcherId)) {
    world.ledgerStore.append(entry)
  }
  return { ...world, watcherId }
}

describe('ownerless idle worker', () => {
  it('parks for a human on a prose question, and stays parked on the next tick', async () => {
    const { service, orchestration, watcherId } = await idleWorld(
      'I found two configs.\n\nShould I merge them or keep both?'
    )

    await service.reconcileForTesting(watcherId)
    expect((await service.fleet()).entries[0]).toMatchObject({
      entry: {
        enrollment: { enabled: false },
        status: {
          state: 'parked',
          parkReason: {
            kind: 'worker-escalation',
            messageId: `prose-question:${IDLE_SINCE_MS}`
          }
        }
      }
    })

    await service.reconcileForTesting(watcherId)
    const ledger = service.ledger(watcherId)
    const open = getLatestEscalations(ledger).filter(
      (entry) => entry.status === 'open' || entry.status === 'escalated'
    )
    expect(open.map((entry) => entry.escalationKind).sort()).toEqual([
      'park-worker-escalation',
      'worker-escalation'
    ])
    expect(open.find((entry) => entry.escalationKind === 'worker-escalation')?.reason).toContain(
      'Should I merge them or keep both?'
    )
    expect(
      ledger.entries.some(
        (entry) => entry.kind === 'escalation' && entry.escalationKind === 'worker-question'
      )
    ).toBe(false)
    expect(orchestration.readQuestion).not.toHaveBeenCalled()
    expect((await service.fleet()).entries[0]).toMatchObject({
      entry: { enrollment: { enabled: false }, status: { state: 'parked' } }
    })
  })

  it('records an observation, not a park, when the worker is idle without a question', async () => {
    const { service, watcherId } = await idleWorld('All done. Tests pass.')

    await service.reconcileForTesting(watcherId)
    await service.reconcileForTesting(watcherId)

    const ledger = service.ledger(watcherId)
    expect(
      ledger.entries.filter(
        (entry) => entry.kind === 'client-observation' && entry.what === WORKER_IDLE_OBSERVATION
      )
    ).toHaveLength(1)
    expect(getLatestEscalations(ledger).filter((entry) => entry.status === 'open')).toEqual([])
    expect((await service.fleet()).entries[0]).toMatchObject({
      entry: { enrollment: { enabled: true } }
    })
  })

  it('polls no slower than the rapid tier while the grace window runs', async () => {
    const { service, schedule, watcherId } = await idleWorld(
      'Should I continue?',
      IDLE_SINCE_MS + OWNER_IDLE_GRACE_MS - 5_000
    )

    await service.reconcileForTesting(watcherId)

    expect(schedule.mock.calls.at(-1)?.[1]).toBe(5_000)
    expect((await service.fleet()).entries[0]).toMatchObject({
      entry: { enrollment: { enabled: true } }
    })
  })
})
