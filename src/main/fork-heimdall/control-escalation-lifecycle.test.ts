import { describe, expect, it } from 'vitest'
import type {
  EscalationEntry,
  LedgerEntry,
  WatcherLedger
} from '../../shared/fork-heimdall/ledger-types'
import { WatcherControlEscalationLifecycle } from './control-escalation-lifecycle'
import type { HeimdallLedgerStore } from './ledger-store'

function fakeLedger(initial: LedgerEntry[] = []): {
  store: HeimdallLedgerStore
  entries: LedgerEntry[]
} {
  const entries = [...initial]
  const store = {
    read: (watcherId: string): WatcherLedger => ({
      watcherId,
      entries: entries.filter((entry) => entry.watcherId === watcherId)
    }),
    append: (entry: LedgerEntry): number => {
      entries.push(entry)
      return entries.length
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: HeimdallLedgerStore is a class with private fields, so a structural test double can never satisfy it without this cast; only read/append are exercised by the code under test.
  return { store: store as unknown as HeimdallLedgerStore, entries }
}

function ownerDeviationEntry(overrides: Partial<EscalationEntry> = {}): EscalationEntry {
  return {
    eventId: 'deviation-1',
    watcherId: 'watcher-1',
    atMs: 1,
    origin: 'owner',
    class: 'fact',
    kind: 'escalation',
    escalationId: 'owner-deviation:watcher-1:worker-question:message-1',
    escalationKind: 'owner-deviation',
    status: 'escalated',
    foldCount: 2,
    reason: JSON.stringify({
      summary: 'worker-question',
      note: 'escalated: no reply',
      deviation: {
        kind: 'worker-question',
        messageId: 'message-1',
        dispatchId: 'dispatch-1',
        question: 'Which branch?'
      }
    }),
    ...overrides
  }
}

function stallDeviationEntry(overrides: Partial<EscalationEntry> = {}): EscalationEntry {
  return ownerDeviationEntry({
    eventId: 'deviation-2',
    escalationId: 'owner-deviation:watcher-1:stall:dispatch-2',
    reason: JSON.stringify({
      summary: 'stall',
      note: 'escalated: stalled',
      deviation: {
        kind: 'stall',
        what: 'dispatch-node',
        dispatchId: 'dispatch-2',
        inFlightSinceMs: 1,
        thresholdMs: 1
      }
    }),
    ...overrides
  })
}

function latestWithEscalationId(
  entries: LedgerEntry[],
  escalationId: string
): EscalationEntry | undefined {
  return entries
    .filter((entry): entry is EscalationEntry => entry.kind === 'escalation')
    .findLast((entry) => entry.escalationId === escalationId)
}

function parkEntry(
  escalationId: string,
  overrides: Partial<EscalationEntry> = {}
): EscalationEntry {
  return {
    eventId: 'park-1',
    watcherId: 'watcher-1',
    atMs: 1,
    origin: 'owner',
    class: 'fact',
    kind: 'escalation',
    escalationId: `park:watcher-1:owner-escalation:${encodeURIComponent(escalationId)}`,
    escalationKind: 'park-owner-escalation',
    status: 'open',
    foldCount: 1,
    reason: 'needs a person',
    ...overrides
  }
}

describe('WatcherControlEscalationLifecycle.prepareAnswerEscalation', () => {
  it('refuses when the watcher is not parked on that escalation', () => {
    const { store } = fakeLedger([])
    const lifecycle = new WatcherControlEscalationLifecycle({
      ledger: store,
      now: () => 10,
      createId: () => 'event-2'
    })

    const result = lifecycle.prepareAnswerEscalation(
      'watcher-1',
      'owner-deviation:watcher-1:worker-question:message-1',
      'Use main.'
    )

    expect(result).toMatchObject({ status: 'refused' })
  })

  it('refuses when the targeted deviation is no longer escalated', () => {
    const deviation = ownerDeviationEntry({ status: 'open' })
    const { store } = fakeLedger([deviation, parkEntry(deviation.escalationId)])
    const lifecycle = new WatcherControlEscalationLifecycle({
      ledger: store,
      now: () => 10,
      createId: () => 'event-2'
    })

    const result = lifecycle.prepareAnswerEscalation(
      'watcher-1',
      deviation.escalationId,
      'Use main.'
    )

    expect(result).toMatchObject({ status: 'refused' })
  })

  it('reopens the deviation with a fresh budget and the reply, and acknowledges the park it answers', () => {
    const deviation = ownerDeviationEntry()
    const park = parkEntry(deviation.escalationId)
    const { store, entries } = fakeLedger([deviation, park])
    let id = 0
    const lifecycle = new WatcherControlEscalationLifecycle({
      ledger: store,
      now: () => 99,
      createId: () => `event-${++id}`
    })

    const preparation = lifecycle.prepareAnswerEscalation(
      'watcher-1',
      deviation.escalationId,
      'Use main.'
    )
    if (preparation.status !== 'ready') {
      throw new Error('expected a ready preparation')
    }
    preparation.apply()

    expect(entries).toHaveLength(4)
    expect(entries[2]).toMatchObject({
      escalationId: deviation.escalationId,
      status: 'open',
      foldCount: 1,
      humanReply: { body: 'Use main.', atMs: 99 }
    })
    expect(entries[3]).toMatchObject({
      escalationId: park.escalationId,
      escalationKind: 'park-owner-escalation',
      status: 'acknowledged',
      foldCount: 2
    })
  })
})

describe('WatcherControlEscalationLifecycle.appendResumeTransitions', () => {
  it('reopens the owner-escalation the active park is waiting on but leaves an unrelated escalated stall alone', () => {
    const answerable = ownerDeviationEntry()
    const stall = stallDeviationEntry()
    const park = parkEntry(answerable.escalationId)
    const { store, entries } = fakeLedger([answerable, stall, park])
    let id = 0
    const lifecycle = new WatcherControlEscalationLifecycle({
      ledger: store,
      now: () => 50,
      createId: () => `event-${++id}`
    })

    lifecycle.appendResumeTransitions('watcher-1')

    const latestAnswerable = latestWithEscalationId(entries, answerable.escalationId)
    const latestStall = latestWithEscalationId(entries, stall.escalationId)
    const latestPark = latestWithEscalationId(entries, park.escalationId)

    expect(latestAnswerable).toMatchObject({ status: 'acknowledged', foldCount: 3 })
    expect(latestStall).toBe(stall)
    expect(latestPark).toMatchObject({ status: 'acknowledged', foldCount: 2 })
  })
})
