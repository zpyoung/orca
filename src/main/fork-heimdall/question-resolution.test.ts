import { describe, expect, it, vi } from 'vitest'
import type { LedgerEntry } from '../../shared/fork-heimdall/ledger-types'
import { enrollmentInput, harness, kind, runningDispatch } from './kernel-service-test-harness'

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
  it('voids a carried-over question whose thread closed with its dispatch and permits a resume', async () => {
    const { service, orchestration, watcherId } = await parkedOnQuestion()
    expect((await service.list())[0]).toMatchObject({
      status: { state: 'parked', parkReason: { kind: 'worker-question' } }
    })

    vi.mocked(orchestration.readQuestion).mockResolvedValue({ status: 'closed' })
    await service.reconcileForTesting(watcherId)

    const entries = service.ledger(watcherId).entries
    expect(latestEscalation(entries, 'worker-question')).toMatchObject({ status: 'resolved' })
    expect(latestEscalation(entries, 'park-worker-question')).toMatchObject({
      status: 'acknowledged'
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
      status: { state: 'parked', reason: 'ready-to-resume', parkReason: null }
    })

    const parked = (await service.fleet()).entries[0]!
    await expect(
      service.command({
        target: parked.target,
        expectedOwner: parked.ownerFence,
        command: { kind: 'resume' }
      })
    ).resolves.toMatchObject({ status: 'applied' })
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

  it('refuses an answer to a closed thread and clears the escalation it can never satisfy', async () => {
    const { service, orchestration, watcherId } = await parkedOnQuestion()
    vi.mocked(orchestration.answerQuestion).mockRejectedValue(
      Object.assign(
        new Error('Question message-question is closed because its Dispatch is inactive.'),
        {
          code: 'dispatch_inactive'
        }
      )
    )

    const parked = (await service.fleet()).entries[0]!
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
  })
})
