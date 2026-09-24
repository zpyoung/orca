import { describe, expect, it, vi } from 'vitest'
import { getLatestEscalations } from '../../shared/fork-heimdall/ledger-queries'
import type { LedgerEntry } from '../../shared/fork-heimdall/ledger-types'
import { dormantWatcherStatus } from './debug-report'
import { isMalformedKindPayloadEnrollment } from './enrollment-store'
import { enrollmentInput, harness, kind, runningDispatch } from './kernel-service-test-harness'
import { voidUnanswerableQuestion, type QuestionLedgerAccess } from './question-resolution'

vi.mock('electron', () => ({}))

function questionMail(watcherId: string): LedgerEntry {
  return {
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
}

/** Parks a watcher on a worker question, then stops the mailbox so later ticks carry it over. */
async function parkedOnQuestion(
  options: Parameters<typeof harness>[0] = {}
): Promise<Awaited<ReturnType<typeof harness>> & { watcherId: string }> {
  let watcherId = ''
  let delivered = false
  const world = await harness({
    ...options,
    mailbox: () => {
      if (delivered) {
        return []
      }
      delivered = true
      return [questionMail(watcherId)]
    }
  })
  world.service.registerKind(kind())
  const result = await world.service.enroll(enrollmentInput())
  if (result.status !== 'enrolled') {
    throw new Error('expected enrollment')
  }
  watcherId = result.entry.enrollment.watcherId
  for (const entry of runningDispatch(watcherId)) {
    world.ledgerStore.append(entry)
  }
  world.budgetClock.open(watcherId, 'worker-dispatched')
  await world.service.reconcileForTesting(watcherId)
  return { ...world, watcherId }
}

function latestEscalation(entries: readonly LedgerEntry[], escalationKind: string): LedgerEntry {
  const entry = entries.findLast(
    (candidate) => candidate.kind === 'escalation' && candidate.escalationKind === escalationKind
  )
  if (!entry) {
    throw new Error(`expected a ${escalationKind} escalation`)
  }
  return entry
}

describe('Heimdall unanswerable worker questions', () => {
  it('voids a carried-over question, auto-resumes durably, refuses a further resume', async () => {
    const { service, orchestration, watcherId, enrollmentStore, ledgerStore } =
      await parkedOnQuestion()
    expect((await service.list())[0]).toMatchObject({
      status: { state: 'parked', parkReason: { kind: 'worker-question' } }
    })

    vi.mocked(orchestration.readQuestion).mockResolvedValue({ status: 'closed' })
    await service.reconcileForTesting(watcherId)

    const entries = service.ledger(watcherId).entries
    expect(latestEscalation(entries, 'worker-question')).toMatchObject({ status: 'resolved' })
    expect(latestEscalation(entries, 'park-worker-question')).toMatchObject({
      status: 'resolved'
    })
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'evidence',
          evidenceKind: 'worker-question-void',
          payload: { messageId: 'message-question', reason: 'closed' }
        })
      ])
    )
    expect((await service.list())[0]).toMatchObject({
      enrollment: { enabled: true },
      status: { state: 'watching', parkReason: null }
    })

    // provable from a cold read of durable state alone, not the live runner's in-memory status
    const persistedEnrollment = enrollmentStore.get(watcherId)
    if (!persistedEnrollment || isMalformedKindPayloadEnrollment(persistedEnrollment)) {
      throw new Error('expected a valid persisted enrollment')
    }
    expect(persistedEnrollment.enabled).toBe(true)
    expect(dormantWatcherStatus(persistedEnrollment, ledgerStore.read(watcherId)).parkReason).toBe(
      null
    )

    const parked = (await service.fleet()).entries[0]!
    await expect(
      service.command({
        target: parked.target,
        expectedOwner: parked.ownerFence,
        command: { kind: 'resume' }
      })
    ).resolves.toMatchObject({ status: 'applied' })

    const parkBeforeSecondTick = latestEscalation(
      service.ledger(watcherId).entries,
      'park-worker-question'
    )
    await service.reconcileForTesting(watcherId)
    expect(latestEscalation(service.ledger(watcherId).entries, 'park-worker-question')).toEqual(
      parkBeforeSecondTick
    )
  })

  it('keeps an unreachable question open, because lost contact is not settlement', async () => {
    const { service, orchestration, watcherId } = await parkedOnQuestion()

    vi.mocked(orchestration.readQuestion).mockResolvedValue({
      status: 'unverifiable',
      reason: 'coordinator seat could not be read'
    })
    await service.reconcileForTesting(watcherId)

    expect(latestEscalation(service.ledger(watcherId).entries, 'worker-question')).toMatchObject({
      status: 'open'
    })
    expect((await service.list())[0]).toMatchObject({
      status: { state: 'parked', parkReason: { kind: 'worker-question' } }
    })
  })

  it('heals a stale question on resume, so a watcher that never ticks again is still recoverable', async () => {
    const { service, orchestration, watcherId } = await parkedOnQuestion()
    vi.mocked(orchestration.readQuestion).mockResolvedValue({ status: 'answered' })

    const parked = (await service.fleet()).entries[0]!
    await expect(
      service.command({
        target: parked.target,
        expectedOwner: parked.ownerFence,
        command: { kind: 'resume' }
      })
    ).resolves.toMatchObject({ status: 'applied' })
    expect(latestEscalation(service.ledger(watcherId).entries, 'worker-question')).toMatchObject({
      status: 'resolved'
    })
  })

  it('refuses an answer to a closed thread, clears the escalation, and reschedules the watcher', async () => {
    const { service, orchestration, watcherId, schedule } = await parkedOnQuestion()
    vi.mocked(orchestration.answerQuestion).mockRejectedValue(
      Object.assign(
        new Error('Question message-question is closed because its Dispatch is inactive.'),
        {
          code: 'dispatch_inactive'
        }
      )
    )

    const parked = (await service.fleet()).entries[0]!
    schedule.mockClear()
    await expect(
      service.command({
        target: parked.target,
        expectedOwner: parked.ownerFence,
        command: {
          kind: 'answer-question',
          messageId: 'message-question',
          body: 'Use the current branch'
        }
      })
    ).resolves.toMatchObject({ status: 'refused', reason: 'question-already-answered' })
    expect(latestEscalation(service.ledger(watcherId).entries, 'worker-question')).toMatchObject({
      status: 'resolved'
    })
    expect(schedule).toHaveBeenCalled()
  })
})

describe('voidUnanswerableQuestion', () => {
  function openQuestionEntries(watcherId: string, messageId: string): LedgerEntry[] {
    return [
      {
        eventId: 'question-open',
        watcherId,
        atMs: 10,
        origin: 'owner',
        class: 'fact',
        kind: 'escalation',
        escalationId: `worker-question:dispatch-1:${messageId}`,
        escalationKind: 'worker-question',
        status: 'open',
        foldCount: 1
      },
      {
        eventId: 'question-park',
        watcherId,
        atMs: 11,
        origin: 'owner',
        class: 'fact',
        kind: 'escalation',
        escalationId: `park:${watcherId}:worker-question:${messageId}`,
        escalationKind: 'park-worker-question',
        status: 'open',
        foldCount: 1
      }
    ]
  }

  function fakeAccess(entries: LedgerEntry[]): QuestionLedgerAccess {
    let nextId = 0
    return {
      read: () => ({ watcherId: 'watcher-1', entries }),
      append: (entry) => entries.push(entry),
      now: () => 100,
      createId: () => `event-${(nextId += 1)}`
    }
  }

  it('voids a question once orchestration reports it closed', async () => {
    const entries = openQuestionEntries('watcher-1', 'message-1')
    const access = fakeAccess(entries)

    await voidUnanswerableQuestion(access, async () => ({ status: 'closed' }), 'watcher-1')

    expect(
      entries.some(
        (entry) => entry.kind === 'evidence' && entry.evidenceKind === 'worker-question-void'
      )
    ).toBe(true)
    expect(
      getLatestEscalations({ watcherId: 'watcher-1', entries }).every(
        (entry) => entry.status === 'resolved' || entry.status === 'acknowledged'
      )
    ).toBe(true)
  })

  it('never voids a question whose orchestration status is unverifiable', async () => {
    const entries = openQuestionEntries('watcher-1', 'message-1')
    const access = fakeAccess(entries)
    const before = entries.length

    await voidUnanswerableQuestion(
      access,
      async () => ({ status: 'unverifiable', reason: 'seat unreachable' }),
      'watcher-1'
    )

    expect(entries).toHaveLength(before)
  })

  it('voids a still-pending question once the dispatch that asked it has exited', async () => {
    const entries = openQuestionEntries('watcher-1', 'message-1')
    const access = fakeAccess(entries)

    await voidUnanswerableQuestion(
      access,
      async () => ({ status: 'pending' }),
      'watcher-1',
      async () => 'exited'
    )

    expect(
      entries.some(
        (entry) => entry.kind === 'evidence' && entry.evidenceKind === 'worker-question-void'
      )
    ).toBe(true)
    expect(
      getLatestEscalations({ watcherId: 'watcher-1', entries }).every(
        (entry) => entry.status === 'resolved' || entry.status === 'acknowledged'
      )
    ).toBe(true)
  })

  it('never voids a pending question whose dispatch liveness is unverifiable', async () => {
    const entries = openQuestionEntries('watcher-1', 'message-1')
    const access = fakeAccess(entries)
    const before = entries.length

    await voidUnanswerableQuestion(
      access,
      async () => ({ status: 'pending' }),
      'watcher-1',
      async () => 'unverifiable'
    )

    expect(entries).toHaveLength(before)
  })

  it('never voids a pending question whose dispatch is still live', async () => {
    const entries = openQuestionEntries('watcher-1', 'message-1')
    const access = fakeAccess(entries)
    const before = entries.length

    await voidUnanswerableQuestion(
      access,
      async () => ({ status: 'pending' }),
      'watcher-1',
      async () => 'live'
    )

    expect(entries).toHaveLength(before)
  })
})
