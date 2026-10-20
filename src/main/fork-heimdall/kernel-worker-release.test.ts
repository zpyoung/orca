import { describe, expect, it, vi } from 'vitest'
import { WORKER_EXITED_WITHOUT_COMPLETION } from '../../shared/fork-heimdall/effect-certainty'
import type { KernelAction, WatcherKind } from '../../shared/fork-heimdall/kind-contract'
import { getInFlightAttempts, getLatestAttempts } from '../../shared/fork-heimdall/ledger-queries'
import type { EvidenceEntry, LedgerEntry } from '../../shared/fork-heimdall/ledger-types'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import {
  action,
  enrollmentInput,
  harness,
  kind,
  runningDispatch,
  type World
} from './kernel-service-test-harness'
import type { HeimdallOrchestrationAdapter } from './orchestration/orchestration-adapter'

vi.mock('electron', () => ({}))

function workerDone(
  watcherId: string,
  options: { includeSource?: boolean; sequence?: number; deliveryId?: string } = {}
): EvidenceEntry {
  const includeSource = options.includeSource ?? true
  return {
    eventId: 'orchestration-mail:worker-done-message',
    watcherId,
    atMs: 20,
    origin: 'owner',
    class: 'fact',
    kind: 'evidence',
    evidenceKind: 'orchestration-mailbox',
    ...(includeSource
      ? {
          source: {
            kind: 'orchestration' as const,
            sequence: options.sequence ?? 1,
            messageId: 'worker-done-message',
            ...(options.deliveryId ? { deliveryId: options.deliveryId } : {})
          }
        }
      : {}),
    payload: {
      type: 'worker_done',
      payload: { dispatchId: 'dispatch-1', outcome: 'succeeded', taskId: 'task-1' }
    }
  }
}

function rejectedWorkerDone(watcherId: string): EvidenceEntry {
  return {
    ...workerDone(watcherId, { includeSource: false }),
    payload: {
      type: 'worker_done',
      payload: {
        dispatchId: 'dispatch-1',
        outcome: 'failed',
        taskId: 'task-1',
        result: {
          body: 'report rejected',
          reportRejection: { code: 'invalid_report', reason: 'missing required evidence' }
        },
        reportRejection: { code: 'invalid_report', reason: 'missing required evidence' }
      }
    }
  }
}

function mailboxStatus(watcherId: string): EvidenceEntry {
  return {
    eventId: 'orchestration-mail:status-before-replay',
    watcherId,
    atMs: 19,
    origin: 'owner',
    class: 'fact',
    kind: 'evidence',
    evidenceKind: 'orchestration-mailbox',
    source: {
      kind: 'orchestration',
      sequence: 99,
      messageId: 'status-before-replay',
      deliveryId: 'delivery-status'
    },
    payload: { type: 'status', payload: { body: 'still alive' } }
  }
}

async function releaseWorld(
  options: {
    mailbox?: (input: Parameters<HeimdallOrchestrationAdapter['drainMailbox']>[0]) => LedgerEntry[]
    releaseWorker?: HeimdallOrchestrationAdapter['releaseWorker']
    authoritativeWorkerReport?: HeimdallOrchestrationAdapter['readAuthoritativeWorkerReport']
    dispatchObservation?: () => {
      status: 'live' | 'exited' | 'unverifiable'
      reason?: string
    }
    registeredKind?: WatcherKind<World, KernelAction, { label: string }>
  } = {}
) {
  let watcherId = ''
  const world = await harness({
    mailbox: options.mailbox ?? (() => [workerDone(watcherId)]),
    ...(options.releaseWorker ? { releaseWorker: options.releaseWorker } : {}),
    ...(options.authoritativeWorkerReport
      ? { authoritativeWorkerReport: options.authoritativeWorkerReport }
      : {}),
    ...(options.dispatchObservation ? { dispatchObservation: options.dispatchObservation } : {})
  })
  world.service.registerKind(options.registeredKind ?? kind())
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

function appendRunningDispatch(
  append: (entry: LedgerEntry) => void,
  watcherId: string,
  attemptId: string,
  dispatchId: string
): void {
  for (const entry of runningDispatch(watcherId)) {
    if (entry.kind !== 'attempt') {
      continue
    }
    append({
      ...entry,
      eventId: `${entry.eventId}-${attemptId}`,
      attemptId,
      fingerprint: `${entry.fingerprint}-${attemptId}`,
      action: { ...entry.action, evidenceKey: `${entry.action.evidenceKey}-${attemptId}` },
      ...(entry.state === 'running' ? { dispatchId } : {})
    })
  }
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

  it('runs workspace cleanup after worker release on cached ticks and refreshes only when changed', async () => {
    const events: string[] = []
    const reads: boolean[] = []
    const cleanupCalls: { releaseConfirmed: boolean; releaseEvidenceCount: number }[] = []
    const registeredKind = kind({
      read: async (_enrollment, { fresh }) => {
        reads.push(fresh)
        const revision = `snapshot-${reads.length}`
        return {
          freshness: fresh ? ('live' as const) : ('cached' as const),
          contentIdentity: revision,
          observedAtMs: reads.length,
          world: { revision }
        }
      },
      concurrency: {
        canRunAlongside: () => true,
        shouldDrainBudget: () => false,
        preserveAttemptOnContentChange: () => false,
        canRunWhenBudgetExhausted: () => false,
        isIsolatedAttempt: () => false,
        retainWorker: () => false,
        async cleanupWorkspaces(ledger, context) {
          events.push('cleanup')
          cleanupCalls.push({
            releaseConfirmed: context.workerReleaseConfirmed('dispatch-1'),
            releaseEvidenceCount: releaseEvidence(ledger.entries).length
          })
          return cleanupCalls.length === 3
        }
      }
    })
    const releaseWorker = vi.fn(async (_enrollment: WatcherEnrollment, dispatchId: string) => {
      events.push('release')
      return {
        dispatchId,
        state: 'released' as const,
        processAction: 'closed_agent_terminal' as const,
        archive: null
      }
    })
    const world = await releaseWorld({ registeredKind, releaseWorker })

    await world.service.reconcileForTesting(world.watcherId)

    expect(events).toEqual(['release', 'cleanup'])
    expect(cleanupCalls).toEqual([{ releaseConfirmed: true, releaseEvidenceCount: 1 }])
    // the second fresh read follows the worker completion the mailbox delivered this tick
    expect(reads).toEqual([true, true])

    await world.service.reconcileForTesting(world.watcherId)

    expect(reads).toEqual([true, true, false])
    expect(cleanupCalls).toHaveLength(2)

    await world.service.reconcileForTesting(world.watcherId)

    expect(cleanupCalls).toHaveLength(3)
    expect(reads).toEqual([true, true, false, false, true])
    expect(events).toEqual(['release', 'cleanup', 'cleanup', 'cleanup'])
    await world.service.stopForShutdown()
  })

  it('reads fresh once when cleanup changes the world on a cached tick of a reconciling kind', async () => {
    const reads: boolean[] = []
    let cleanupCalls = 0
    const reconcile = vi.fn(async () => undefined)
    const registeredKind = kind({
      read: async (_enrollment, { fresh }) => {
        reads.push(fresh)
        const revision = `snapshot-${reads.length}`
        return {
          freshness: fresh ? ('live' as const) : ('cached' as const),
          contentIdentity: revision,
          observedAtMs: reads.length,
          world: { revision }
        }
      },
      concurrency: {
        canRunAlongside: () => true,
        shouldDrainBudget: () => false,
        preserveAttemptOnContentChange: () => false,
        canRunWhenBudgetExhausted: () => false,
        isIsolatedAttempt: () => false,
        retainWorker: () => false,
        cleanupWorkspaces: async () => {
          cleanupCalls += 1
          return cleanupCalls === 2
        },
        reconcile
      }
    })
    const releaseWorker = vi.fn(async (_enrollment: WatcherEnrollment, dispatchId: string) => ({
      dispatchId,
      state: 'released' as const,
      processAction: 'closed_agent_terminal' as const,
      archive: null
    }))
    const world = await releaseWorld({ registeredKind, releaseWorker })

    await world.service.reconcileForTesting(world.watcherId)
    const readsAfterLiveTick = reads.length
    expect(reconcile).toHaveBeenCalledOnce()

    await world.service.reconcileForTesting(world.watcherId)

    expect(reads.slice(readsAfterLiveTick)).toEqual([false, true])
    expect(reconcile).toHaveBeenCalledOnce()
    await world.service.stopForShutdown()
  })

  it('recovers a durable accepted report, preserves earlier mail, and checkpoints its replay', async () => {
    let drains = 0
    const cursors: { previousDeliveryId: string | null; lastSequence: number }[] = []
    const readAuthoritativeWorkerReport = vi.fn(async (enrollment: WatcherEnrollment) =>
      workerDone(enrollment.watcherId, {
        includeSource: false
      })
    )
    let watcherId = ''
    const world = await releaseWorld({
      mailbox: (input) => {
        cursors.push(input.cursor)
        drains += 1
        return drains === 1
          ? []
          : drains === 2
            ? [
                mailboxStatus(watcherId),
                workerDone(watcherId, {
                  sequence: 100,
                  deliveryId: 'delivery-replay'
                })
              ]
            : []
      },
      authoritativeWorkerReport: readAuthoritativeWorkerReport
    })
    watcherId = world.watcherId

    await world.service.reconcileForTesting(world.watcherId)
    await world.service.reconcileForTesting(world.watcherId)
    await world.service.reconcileForTesting(world.watcherId)

    const ledger = world.service.ledger(world.watcherId)
    expect(
      ledger.entries.filter((entry) => entry.eventId === 'orchestration-mail:worker-done-message')
    ).toHaveLength(1)
    expect(ledger.entries).toContainEqual(
      expect.objectContaining({ eventId: 'orchestration-mail:status-before-replay' })
    )
    expect(ledger.entries).toContainEqual(
      expect.objectContaining({
        evidenceKind: 'orchestration-mailbox-cursor',
        source: expect.objectContaining({
          sequence: 100,
          deliveryId: 'delivery-replay'
        })
      })
    )
    expect(cursors.at(-1)).toEqual({
      previousDeliveryId: 'delivery-replay',
      lastSequence: 100
    })
    expect(
      ledger.entries.filter(
        (entry) =>
          entry.kind === 'attempt' && entry.dispatchId === 'dispatch-1' && entry.state === 'settled'
      )
    ).toHaveLength(1)
    expect(world.orchestration.releaseWorker).toHaveBeenCalledOnce()
    expect(world.orchestration.readDispatch).not.toHaveBeenCalled()
    await world.service.stopForShutdown()
  })

  it('keeps a disk-only report path untrusted while its exact dispatch remains live', async () => {
    const world = await releaseWorld({
      mailbox: () => [],
      dispatchObservation: () => ({ status: 'live' })
    })

    await world.service.reconcileForTesting(world.watcherId)

    expect(world.orchestration.readAuthoritativeWorkerReport).toHaveBeenCalledWith(
      expect.objectContaining({ watcherId: world.watcherId }),
      'dispatch-1'
    )
    expect(getInFlightAttempts(world.service.ledger(world.watcherId))).toHaveLength(1)
    expect(world.orchestration.releaseWorker).not.toHaveBeenCalled()
    await world.service.stopForShutdown()
  })

  it('feeds accepted evidence for a settled-indeterminate attempt through existing recovery', async () => {
    const readAuthoritativeWorkerReport = vi.fn(async (enrollment: WatcherEnrollment) =>
      workerDone(enrollment.watcherId, {
        includeSource: false
      })
    )
    const world = await releaseWorld({
      mailbox: () => [],
      authoritativeWorkerReport: readAuthoritativeWorkerReport
    })
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
      eventId: 'settled-indeterminate-before-report',
      atMs: 12,
      state: 'settled',
      effect: 'indeterminate',
      reason: WORKER_EXITED_WITHOUT_COMPLETION
    })

    await world.service.reconcileForTesting(world.watcherId)

    const ledger = world.service.ledger(world.watcherId)
    expect(ledger.entries).toContainEqual(
      expect.objectContaining({
        eventId: 'orchestration-mail:worker-done-message',
        evidenceKind: 'orchestration-mailbox'
      })
    )
    expect(ledger.entries).toContainEqual(
      expect.objectContaining({
        kind: 'attempt-resolved',
        attemptId: 'attempt-1',
        effect: 'not-landed'
      })
    )
    expect(
      ledger.entries.filter(
        (entry) =>
          entry.kind === 'attempt' && entry.dispatchId === 'dispatch-1' && entry.state === 'settled'
      )
    ).toHaveLength(1)
    expect(world.orchestration.releaseWorker).toHaveBeenCalledOnce()
    await world.service.stopForShutdown()
  })

  it('recovers a durable rejected report as failed without trusting terminal status alone', async () => {
    const world = await releaseWorld({
      mailbox: () => [],
      authoritativeWorkerReport: async (enrollment) => rejectedWorkerDone(enrollment.watcherId)
    })

    await world.service.reconcileForTesting(world.watcherId)

    const ledger = world.service.ledger(world.watcherId)
    expect(ledger.entries).toContainEqual(
      expect.objectContaining({
        eventId: 'orchestration-mail:worker-done-message',
        payload: expect.objectContaining({
          payload: expect.objectContaining({
            outcome: 'failed',
            reportRejection: {
              code: 'invalid_report',
              reason: 'missing required evidence'
            }
          })
        })
      })
    )
    expect(ledger.entries).toContainEqual(
      expect.objectContaining({
        kind: 'attempt',
        dispatchId: 'dispatch-1',
        state: 'settled',
        result: expect.objectContaining({
          reportRejection: {
            code: 'invalid_report',
            reason: 'missing required evidence'
          }
        })
      })
    )
    expect(ledger.entries).toContainEqual(
      expect.objectContaining({
        kind: 'attempt-resolved',
        attemptId: 'attempt-1',
        effect: 'not-landed'
      })
    )
    expect(world.orchestration.releaseWorker).toHaveBeenCalledOnce()
    expect(world.orchestration.readDispatch).not.toHaveBeenCalled()
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

  it('keeps sibling decisions running when an isolated terminal cannot be released', async () => {
    let releaseConfirmed: boolean | null = null
    const decide = vi.fn(() => ({ action: null, reason: 'sibling-ready', considered: [] }))
    const registeredKind = kind({
      decide,
      concurrency: {
        canRunAlongside: () => true,
        shouldDrainBudget: () => false,
        preserveAttemptOnContentChange: () => false,
        canRunWhenBudgetExhausted: () => false,
        isIsolatedAttempt: (attempt) => attempt.dispatchId === 'dispatch-1',
        retainWorker: () => false,
        async reconcile(_snapshot, _ledger, context) {
          releaseConfirmed = context.workerReleaseConfirmed('dispatch-1')
        }
      }
    })
    const world = await releaseWorld({
      registeredKind,
      releaseWorker: vi.fn(async (_enrollment: WatcherEnrollment, dispatchId: string) => ({
        dispatchId,
        state: 'retained' as const,
        reason: 'user_takeover' as const,
        processAction: 'none' as const,
        archive: null
      }))
    })

    await world.service.reconcileForTesting(world.watcherId)

    expect(releaseConfirmed).toBe(false)
    expect(decide).toHaveBeenCalled()
    await world.service.stopForShutdown()
  })

  it('continues sibling liveness while one dispatch has an open question', async () => {
    let watcherId = ''
    const world = await harness({
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
            deliveryId: 'delivery-question'
          },
          payload: {
            type: 'question',
            body: 'Which branch?',
            payload: JSON.stringify({ dispatchId: 'dispatch-1' })
          }
        }
      ],
      dispatchObservation: (dispatchId) =>
        dispatchId === 'dispatch-2' ? { status: 'exited' } : { status: 'live' }
    })
    world.service.registerKind(kind())
    const enrolled = await world.service.enroll(enrollmentInput())
    if (enrolled.status !== 'enrolled') {
      throw new Error('Expected enrollment')
    }
    watcherId = enrolled.entry.enrollment.watcherId
    appendRunningDispatch(
      (entry) => world.ledgerStore.append(entry),
      watcherId,
      'attempt-1',
      'dispatch-1'
    )
    appendRunningDispatch(
      (entry) => world.ledgerStore.append(entry),
      watcherId,
      'attempt-2',
      'dispatch-2'
    )

    await world.service.reconcileForTesting(watcherId)

    expect(world.orchestration.readDispatch).not.toHaveBeenCalledWith(
      expect.anything(),
      'dispatch-1'
    )
    expect(world.orchestration.readDispatch).toHaveBeenCalledWith(expect.anything(), 'dispatch-2')
    expect(
      getLatestAttempts(world.service.ledger(watcherId)).find(
        (attempt) => attempt.dispatchId === 'dispatch-2'
      )
    ).toMatchObject({ state: 'settled', effect: 'indeterminate' })
    await world.service.stopForShutdown()
  })

  it('keeps a live sibling budget reference after one dispatch loses contact', async () => {
    let phase: 'live' | 'unverifiable' = 'live'
    const world = await harness({
      mailbox: () => [],
      dispatchObservation: (dispatchId) =>
        phase === 'unverifiable' && dispatchId === 'dispatch-1'
          ? { status: 'unverifiable', reason: 'SSH transport disconnected' }
          : { status: 'live' }
    })
    world.service.registerKind(kind())
    const enrolled = await world.service.enroll(enrollmentInput())
    if (enrolled.status !== 'enrolled') {
      throw new Error('Expected enrollment')
    }
    const watcherId = enrolled.entry.enrollment.watcherId
    appendRunningDispatch(
      (entry) => world.ledgerStore.append(entry),
      watcherId,
      'attempt-1',
      'dispatch-1'
    )
    appendRunningDispatch(
      (entry) => world.ledgerStore.append(entry),
      watcherId,
      'attempt-2',
      'dispatch-2'
    )
    await world.service.reconcileForTesting(watcherId)
    phase = 'unverifiable'

    await world.service.reconcileForTesting(watcherId)

    expect(world.budgetClock.current(watcherId)).not.toBeNull()
    expect(
      world.service.ledger(watcherId).entries.filter((entry) => entry.kind === 'interval-close')
    ).toHaveLength(0)
    await world.service.stopForShutdown()
  })

  it('keeps a disconnected worker in flight without licensing a duplicate dispatch', async () => {
    const world = await harness({
      mailbox: () => [],
      dispatchObservation: () => ({ status: 'unverifiable', reason: 'SSH transport disconnected' })
    })
    world.service.registerKind(
      kind({
        decide: () => ({ action: action('revision-1') })
      })
    )
    const enrolled = await world.service.enroll(enrollmentInput())
    if (enrolled.status !== 'enrolled') {
      throw new Error('Expected enrollment')
    }
    const watcherId = enrolled.entry.enrollment.watcherId
    for (const entry of runningDispatch(watcherId)) {
      world.ledgerStore.append(entry)
    }

    await world.service.reconcileForTesting(watcherId)

    expect(getInFlightAttempts(world.service.ledger(watcherId))).toHaveLength(1)
    expect(world.orchestration.dispatchWorker).not.toHaveBeenCalled()
    expect((await world.service.list())[0]).toMatchObject({
      status: {
        state: 'unreachable',
        phase: 'worker-unverifiable',
        reason: 'SSH transport disconnected'
      }
    })
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
