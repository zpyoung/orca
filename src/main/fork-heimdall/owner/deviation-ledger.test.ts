import { describe, expect, it } from 'vitest'
import type { LedgerEntry, WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import type { Deviation } from '../../../shared/fork-heimdall/owner/deviation'
import {
  decodeOwnerDeviation,
  deviationRetriesExhausted,
  escalateDeviationToHuman,
  findOldestOpenOwnerDeviation,
  findOwnerDeviationEscalation,
  markOwnerTurnSent,
  ownerDeviationEscalationId,
  ownerDeviationWakeToken,
  ownerTurnAwaitingSend,
  recordDeviation,
  reRaiseDeviation,
  resolveDeviation,
  type DeviationRecordDependencies
} from './deviation-ledger'

function memoryStore(): DeviationRecordDependencies & {
  entries(watcherId: string): LedgerEntry[]
} {
  const byWatcher = new Map<string, LedgerEntry[]>()
  let clock = 0
  let ids = 0
  return {
    ledgerStore: {
      read(watcherId: string): WatcherLedger {
        return { watcherId, entries: byWatcher.get(watcherId) ?? [] }
      },
      append(watcherId: string, entry: LedgerEntry): void {
        const list = byWatcher.get(watcherId) ?? []
        list.push(entry)
        byWatcher.set(watcherId, list)
      }
    },
    now: () => ++clock,
    createId: () => `event-${++ids}`,
    entries: (watcherId: string) => byWatcher.get(watcherId) ?? []
  }
}

const questionDeviation: Deviation = {
  kind: 'worker-question',
  messageId: 'message-1',
  dispatchId: 'dispatch-1',
  question: 'Which branch?'
}

const otherDeviation: Deviation = {
  kind: 'worker-question',
  messageId: 'message-2',
  dispatchId: 'dispatch-2',
  question: 'Which config?'
}

const noUsablePlanDeviation: Deviation = {
  kind: 'plan-failed',
  reason: 'no-usable-plan'
}

const activationFailedDeviation: Deviation = {
  kind: 'plan-failed',
  reason: 'activation-not-landed',
  revisionId: 'revision-1',
  revisionNumber: 1
}

describe('plan-failed round-trips without requiring fields the caller cannot supply', () => {
  it('records and decodes a no-usable-plan deviation with no revision at all', () => {
    const deps = memoryStore()
    const entry = recordDeviation(deps, 'watcher-1', noUsablePlanDeviation)
    expect(decodeOwnerDeviation(entry)).toEqual(noUsablePlanDeviation)
  })

  it('keeps a per-revision activation failure distinct from the no-usable-plan case', () => {
    const deps = memoryStore()
    recordDeviation(deps, 'watcher-1', noUsablePlanDeviation)
    recordDeviation(deps, 'watcher-1', activationFailedDeviation)
    expect(deps.entries('watcher-1')).toHaveLength(2)
  })
})

describe('recordDeviation', () => {
  it('appends a new open escalation for a first observation', () => {
    const deps = memoryStore()
    const entry = recordDeviation(deps, 'watcher-1', questionDeviation)
    expect(entry.status).toBe('open')
    expect(entry.foldCount).toBe(1)
    expect(entry.escalationId).toBe(ownerDeviationEscalationId('watcher-1', questionDeviation))
    expect(deps.entries('watcher-1')).toHaveLength(1)
  })

  it('dedupes a repeat observation of the same open deviation across ticks', () => {
    const deps = memoryStore()
    recordDeviation(deps, 'watcher-1', questionDeviation)
    recordDeviation(deps, 'watcher-1', questionDeviation)
    expect(deps.entries('watcher-1')).toHaveLength(1)
  })

  it('records distinct deviations as distinct escalations', () => {
    const deps = memoryStore()
    recordDeviation(deps, 'watcher-1', questionDeviation)
    recordDeviation(deps, 'watcher-1', otherDeviation)
    expect(deps.entries('watcher-1')).toHaveLength(2)
  })

  it('round-trips the structured deviation through the encoded reason', () => {
    const deps = memoryStore()
    const entry = recordDeviation(deps, 'watcher-1', questionDeviation)
    expect(decodeOwnerDeviation(entry)).toEqual(questionDeviation)
  })

  it('re-opens with a fresh retry budget once a prior occurrence for the same key resolved', () => {
    const deps = memoryStore()
    const first = recordDeviation(deps, 'watcher-1', questionDeviation)
    resolveDeviation(deps, 'watcher-1', first)
    const second = recordDeviation(deps, 'watcher-1', questionDeviation)
    expect(second.status).toBe('open')
    expect(second.foldCount).toBe(1)
  })
})

describe('owner deviation wake identity', () => {
  it('stays stable when the same turn is marked sent', () => {
    const deps = memoryStore()
    const recorded = recordDeviation(deps, 'watcher-1', questionDeviation)
    const sent = markOwnerTurnSent(deps, 'watcher-1', recorded)

    expect(ownerDeviationWakeToken(sent)).toBe(ownerDeviationWakeToken(recorded))
  })

  it('changes for a retry wake and for a fresh recurrence after resolution', () => {
    const deps = memoryStore()
    const first = recordDeviation(deps, 'watcher-1', questionDeviation)
    const retry = reRaiseDeviation(deps, 'watcher-1', first, 'gate rejection')
    expect(ownerDeviationWakeToken(retry)).not.toBe(ownerDeviationWakeToken(first))
    expect(ownerDeviationWakeToken(retry)).toBe(`${retry.escalationId}:2:${first.eventId}`)

    resolveDeviation(deps, 'watcher-1', retry)
    const recurrence = recordDeviation(deps, 'watcher-1', questionDeviation)
    expect(recurrence.foldCount).toBe(1)
    expect(ownerDeviationWakeToken(recurrence)).not.toBe(ownerDeviationWakeToken(first))
    expect(ownerDeviationWakeToken(recurrence)).toBe(
      `${recurrence.escalationId}:1:${recurrence.eventId}`
    )
  })

  it('preserves a legacy token across the mark-sent revision', () => {
    const deps = memoryStore()
    const recorded = recordDeviation(deps, 'watcher-1', questionDeviation)
    const legacy = {
      ...recorded,
      reason: JSON.stringify({
        summary: 'worker-question',
        note: 'recorded',
        deviation: questionDeviation
      })
    }

    expect(ownerDeviationWakeToken(legacy)).toBe(`${legacy.escalationId}:1`)
    expect(ownerDeviationWakeToken(markOwnerTurnSent(deps, 'watcher-1', legacy))).toBe(
      `${legacy.escalationId}:1`
    )
  })
})

describe('findOldestOpenOwnerDeviation', () => {
  it('returns the earliest still-open deviation when more than one is pending', () => {
    const deps = memoryStore()
    recordDeviation(deps, 'watcher-1', questionDeviation)
    recordDeviation(deps, 'watcher-1', otherDeviation)
    const ledger = deps.ledgerStore.read('watcher-1')
    const oldest = findOldestOpenOwnerDeviation(ledger)
    expect(oldest && decodeOwnerDeviation(oldest)).toEqual(questionDeviation)
  })

  it('is null once every deviation has resolved or escalated', () => {
    const deps = memoryStore()
    const entry = recordDeviation(deps, 'watcher-1', questionDeviation)
    resolveDeviation(deps, 'watcher-1', entry)
    expect(findOldestOpenOwnerDeviation(deps.ledgerStore.read('watcher-1'))).toBeNull()
  })
})

describe('retry-once-then-escalate bookkeeping', () => {
  it('is not exhausted on the first wake', () => {
    const deps = memoryStore()
    const entry = recordDeviation(deps, 'watcher-1', questionDeviation)
    expect(deviationRetriesExhausted(entry)).toBe(false)
  })

  it('is exhausted once re-raised once', () => {
    const deps = memoryStore()
    const entry = recordDeviation(deps, 'watcher-1', questionDeviation)
    const rewoken = reRaiseDeviation(deps, 'watcher-1', entry, 'gate rejection')
    expect(deviationRetriesExhausted(rewoken)).toBe(true)
  })

  it('preserves the decodable deviation across a re-raise', () => {
    const deps = memoryStore()
    const entry = recordDeviation(deps, 'watcher-1', questionDeviation)
    const rewoken = reRaiseDeviation(deps, 'watcher-1', entry, 'gate rejection')
    expect(decodeOwnerDeviation(rewoken)).toEqual(questionDeviation)
  })

  it('marks a turn sent without spending a retry', () => {
    const deps = memoryStore()
    const entry = recordDeviation(deps, 'watcher-1', questionDeviation)
    const sent = markOwnerTurnSent(deps, 'watcher-1', entry)
    expect(sent.foldCount).toBe(entry.foldCount)
    expect(ownerTurnAwaitingSend(sent)).toBe(false)
  })

  it('is still awaiting-send immediately after recording', () => {
    const deps = memoryStore()
    const entry = recordDeviation(deps, 'watcher-1', questionDeviation)
    expect(ownerTurnAwaitingSend(entry)).toBe(true)
  })

  it('escalateDeviationToHuman marks the escalation escalated and preserves the deviation', () => {
    const deps = memoryStore()
    const entry = recordDeviation(deps, 'watcher-1', questionDeviation)
    const escalated = escalateDeviationToHuman(deps, 'watcher-1', entry, 'unreachable')
    expect(escalated.status).toBe('escalated')
    expect(decodeOwnerDeviation(escalated)).toEqual(questionDeviation)
    expect(
      findOwnerDeviationEscalation(
        deps.ledgerStore.read('watcher-1'),
        'watcher-1',
        questionDeviation
      )?.status
    ).toBe('escalated')
  })
})

describe('humanReply propagation', () => {
  it('carries an answered reply forward across a re-raise and a later escalation to human', () => {
    const deps = memoryStore()
    const entry = recordDeviation(deps, 'watcher-1', questionDeviation)
    const answered = {
      ...entry,
      eventId: 'answered',
      atMs: deps.now(),
      status: 'open' as const,
      foldCount: 1,
      humanReply: { body: 'Use main.', atMs: 5 }
    }
    deps.ledgerStore.append('watcher-1', answered)

    const rewoken = reRaiseDeviation(deps, 'watcher-1', answered, 'gate rejection')
    expect(rewoken.humanReply).toEqual({ body: 'Use main.', atMs: 5 })

    const escalated = escalateDeviationToHuman(deps, 'watcher-1', rewoken, 'unreachable')
    expect(escalated.humanReply).toEqual({ body: 'Use main.', atMs: 5 })
  })
})
