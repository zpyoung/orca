import { describe, expect, it, vi } from 'vitest'
import { WORKER_EXITED_WITHOUT_COMPLETION } from '../../shared/fork-heimdall/effect-certainty'
import { getInFlightAttempts } from '../../shared/fork-heimdall/ledger-queries'
import type { LedgerEntry } from '../../shared/fork-heimdall/ledger-types'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import { enrollmentInput, harness, kind, runningDispatch } from './kernel-service-test-harness'
import type { HeimdallOrchestrationAdapter } from './orchestration/orchestration-adapter'

vi.mock('electron', () => ({}))

function workerDone(watcherId: string): LedgerEntry {
  return {
    eventId: 'worker-done',
    watcherId,
    atMs: 20,
    origin: 'owner',
    class: 'fact',
    kind: 'evidence',
    evidenceKind: 'orchestration-mailbox',
    source: {
      kind: 'orchestration',
      sequence: 1,
      messageId: 'worker-done-message'
    },
    payload: {
      type: 'worker_done',
      payload: { dispatchId: 'dispatch-1', outcome: 'succeeded', taskId: 'task-1' }
    }
  }
}

async function releaseWorld(
  options: {
    mailbox?: () => LedgerEntry[]
    releaseWorker?: HeimdallOrchestrationAdapter['releaseWorker']
    dispatchObservation?: () => {
      status: 'live' | 'exited' | 'unverifiable'
      reason?: string
    }
  } = {}
) {
  let watcherId = ''
  const world = await harness({
    mailbox: options.mailbox ?? (() => [workerDone(watcherId)]),
    ...(options.releaseWorker ? { releaseWorker: options.releaseWorker } : {}),
    ...(options.dispatchObservation ? { dispatchObservation: options.dispatchObservation } : {})
  })
  world.service.registerKind(kind())
  const enrolled = await world.service.enroll(enrollmentInput())
  if (enrolled.status !== 'enrolled') {
    throw new Error('Expected enrollment')
  }
  watcherId = enrolled.entry.enrollment.watcherId
  for (const entry of runningDispatch(watcherId)) {
    world.ledgerStore.append(entry)
  }
  return { ...world, watcherId }
}

function releaseEvidence(entries: readonly LedgerEntry[]): LedgerEntry[] {
  return entries.filter(
    (entry) => entry.kind === 'evidence' && entry.evidenceKind === 'worker-terminal-released'
  )
}

describe('Heimdall settled worker release', () => {
  it('releases a drained worker_done dispatch only once', async () => {
    const world = await releaseWorld()

    await world.service.reconcileForTesting(world.watcherId)
    await world.service.reconcileForTesting(world.watcherId)

    expect(world.orchestration.releaseWorker).toHaveBeenCalledOnce()
    expect(world.orchestration.releaseWorker).toHaveBeenCalledWith(
      expect.objectContaining({ watcherId: world.watcherId }),
      'dispatch-1'
    )
    expect(releaseEvidence(world.service.ledger(world.watcherId).entries)).toEqual([
      expect.objectContaining({
        origin: 'owner',
        class: 'fact',
        payload: expect.objectContaining({
          dispatchId: 'dispatch-1',
          state: 'released',
          processAction: 'closed_agent_terminal'
        })
      })
    ])
    await world.service.stopForShutdown()
  })

  it('releases an exited dispatch only once', async () => {
    const world = await releaseWorld({
      mailbox: () => [],
      dispatchObservation: () => ({ status: 'exited' })
    })

    await world.service.reconcileForTesting(world.watcherId)
    await world.service.reconcileForTesting(world.watcherId)

    const ledger = world.service.ledger(world.watcherId)
    expect(world.orchestration.releaseWorker).toHaveBeenCalledOnce()
    expect(world.orchestration.releaseWorker).toHaveBeenCalledWith(
      expect.objectContaining({ watcherId: world.watcherId }),
      'dispatch-1'
    )
    expect(ledger.entries).toContainEqual(
      expect.objectContaining({
        kind: 'attempt',
        dispatchId: 'dispatch-1',
        state: 'settled',
        effect: 'indeterminate',
        reason: WORKER_EXITED_WITHOUT_COMPLETION
      })
    )
    expect(releaseEvidence(ledger.entries)).toEqual([
      expect.objectContaining({
        origin: 'owner',
        class: 'fact',
        payload: expect.objectContaining({
          dispatchId: 'dispatch-1',
          state: 'released',
          processAction: 'closed_agent_terminal'
        })
      })
    ])
    await world.service.stopForShutdown()
  })

  it('releases an already-settled exited dispatch during recovery', async () => {
    const world = await releaseWorld({ mailbox: () => [] })
    const running = world.service
      .ledger(world.watcherId)
      .entries.findLast(
        (entry): entry is Extract<LedgerEntry, { kind: 'attempt' }> =>
          entry.kind === 'attempt' && entry.state === 'running'
      )
    if (!running) {
      throw new Error('Expected running dispatch')
    }
    world.ledgerStore.append({
      ...running,
      eventId: 'historical-exited-event',
      atMs: 12,
      state: 'settled',
      effect: 'indeterminate',
      reason: WORKER_EXITED_WITHOUT_COMPLETION
    })

    await world.service.reconcileForTesting(world.watcherId)
    await world.service.reconcileForTesting(world.watcherId)

    const ledger = world.service.ledger(world.watcherId)
    expect(world.orchestration.readDispatch).not.toHaveBeenCalled()
    expect(world.orchestration.releaseWorker).toHaveBeenCalledOnce()
    expect(world.orchestration.releaseWorker).toHaveBeenCalledWith(
      expect.objectContaining({ watcherId: world.watcherId }),
      'dispatch-1'
    )
    expect(ledger.entries).toContainEqual(
      expect.objectContaining({
        kind: 'attempt-resolved',
        attemptId: 'attempt-1',
        effect: 'not-landed'
      })
    )
    expect(releaseEvidence(ledger.entries)).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          dispatchId: 'dispatch-1',
          state: 'released'
        })
      })
    ])
    await world.service.stopForShutdown()
  })

  it('preserves a retained terminal reason in release evidence', async () => {
    const releaseWorker = vi.fn(async (_enrollment: WatcherEnrollment, dispatchId: string) => ({
      dispatchId,
      state: 'retained' as const,
      reason: 'user_takeover' as const,
      processAction: 'none' as const,
      archive: null
    }))
    const world = await releaseWorld({ releaseWorker })

    await world.service.reconcileForTesting(world.watcherId)

    expect(releaseEvidence(world.service.ledger(world.watcherId).entries)).toEqual([
      expect.objectContaining({
        evidenceKind: 'worker-terminal-released',
        payload: {
          dispatchId: 'dispatch-1',
          state: 'retained',
          reason: 'user_takeover',
          processAction: 'none'
        }
      })
    ])
    await world.service.stopForShutdown()
  })

  it('keeps exited settlement and ticks successful when release rejects', async () => {
    const releaseWorker = vi.fn(async () => {
      throw new Error('release host offline')
    })
    const world = await releaseWorld({
      mailbox: () => [],
      releaseWorker,
      dispatchObservation: () => ({ status: 'exited' })
    })

    await world.service.reconcileForTesting(world.watcherId)
    await world.service.reconcileForTesting(world.watcherId)

    const ledger = world.service.ledger(world.watcherId)
    expect(releaseWorker).toHaveBeenCalledOnce()
    expect(getInFlightAttempts(ledger)).toHaveLength(0)
    expect(ledger.entries).toContainEqual(
      expect.objectContaining({
        kind: 'attempt',
        dispatchId: 'dispatch-1',
        state: 'settled',
        effect: 'indeterminate',
        reason: WORKER_EXITED_WITHOUT_COMPLETION
      })
    )
    expect(ledger.entries).toContainEqual(
      expect.objectContaining({
        origin: 'owner',
        class: 'fact',
        kind: 'evidence',
        evidenceKind: 'worker-terminal-release-error',
        payload: { dispatchId: 'dispatch-1', error: 'release host offline' }
      })
    )
    expect((await world.service.list())[0]).toMatchObject({
      status: { state: 'watching', phase: 'watching', reason: null }
    })
    expect(world.ledgerStore.readTickTraces(world.watcherId).at(-1)).toMatchObject({
      exitPath: 'watching',
      error: null
    })
    await world.service.stopForShutdown()
  })
})
