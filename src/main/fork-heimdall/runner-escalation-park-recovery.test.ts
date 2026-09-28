import { describe, expect, it, vi } from 'vitest'
import { getLatestEscalations } from '../../shared/fork-heimdall/ledger-queries'
import type { LedgerEntry } from '../../shared/fork-heimdall/ledger-types'
import { enrollmentInput, harness, kind, runningDispatch } from './kernel-service-test-harness'

vi.mock('electron', () => ({}))

function mailboxEntry(
  watcherId: string,
  sequence: number,
  payload: Record<string, unknown>
): LedgerEntry {
  return {
    eventId: `mail-${sequence}`,
    watcherId,
    atMs: 20 + sequence,
    origin: 'owner',
    class: 'fact',
    kind: 'evidence',
    evidenceKind: 'orchestration-mailbox',
    source: {
      kind: 'orchestration',
      sequence,
      messageId: `message-${sequence}`,
      deliveryId: `delivery-${sequence}`
    },
    payload
  }
}

function escalation(watcherId: string): LedgerEntry {
  return mailboxEntry(watcherId, 1, {
    type: 'escalation',
    subject: 'Blocked',
    body: 'The visual smoke could not run here',
    payload: { dispatchId: 'dispatch-1' }
  })
}

function workerDone(watcherId: string, outcome: string): LedgerEntry {
  return mailboxEntry(watcherId, 2, {
    type: 'worker_done',
    payload: { dispatchId: 'dispatch-1', outcome }
  })
}

/** Parks the watcher on a worker escalation, then delivers `outcome` for the same dispatch. */
async function parkThenSettle(outcome: string) {
  let watcherId = ''
  const mailbox: LedgerEntry[] = []
  const world = await harness({ mailbox: () => mailbox })
  world.service.registerKind(kind())
  const result = await world.service.enroll(
    enrollmentInput({ wallClockActiveMs: 100_000, turns: 100 })
  )
  if (result.status !== 'enrolled') {
    throw new Error('expected enrollment')
  }
  watcherId = result.entry.enrollment.watcherId
  for (const entry of runningDispatch(watcherId)) {
    world.ledgerStore.append(entry)
  }
  world.budgetClock.open(watcherId, 'worker-dispatched')

  mailbox.push(escalation(watcherId))
  await world.service.reconcileForTesting(watcherId)
  const parked = (await world.service.fleet()).entries[0]
  expect(parked).toMatchObject({
    entry: { enrollment: { enabled: false }, status: { state: 'parked' } }
  })

  mailbox.push(workerDone(watcherId, outcome))
  await world.service.reconcileForTesting(watcherId)
  return { ...world, watcherId }
}

function latestPark(entries: readonly LedgerEntry[]) {
  return entries.findLast(
    (entry) => entry.kind === 'escalation' && entry.escalationKind === 'park-worker-escalation'
  )
}

describe('worker-escalation park recovery', () => {
  it('resumes itself once the escalated dispatch lands, without an operator resume', async () => {
    const { service, watcherId } = await parkThenSettle('succeeded')

    expect((await service.fleet()).entries[0]).toMatchObject({
      entry: { enrollment: { enabled: true }, status: { state: 'watching', reason: null } }
    })
    expect(latestPark(service.ledger(watcherId).entries)).toMatchObject({ status: 'resolved' })
    expect(
      getLatestEscalations(service.ledger(watcherId)).filter(
        (entry) => entry.status === 'open' || entry.status === 'escalated'
      )
    ).toEqual([])
  })

  it('stays parked when the escalated dispatch settles without landing', async () => {
    const { service, watcherId } = await parkThenSettle('failed')

    expect((await service.fleet()).entries[0]).toMatchObject({
      entry: { enrollment: { enabled: false }, status: { state: 'parked' } }
    })
    expect(latestPark(service.ledger(watcherId).entries)).toMatchObject({ status: 'open' })
  })
})
