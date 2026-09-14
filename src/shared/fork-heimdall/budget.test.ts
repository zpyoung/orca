import { describe, expect, it } from 'vitest'
import { deriveBudgetState } from './budget'
import type { LedgerEntry, WatcherLedger } from './ledger-types'

const OWNER_FACT = {
  watcherId: 'watcher-1',
  origin: 'owner' as const,
  class: 'fact' as const
}

function ledger(...entries: LedgerEntry[]): WatcherLedger {
  return { watcherId: 'watcher-1', entries }
}

describe('Heimdall budget derivation', () => {
  it('never reduces charged active time when a normal close clock trails its checkpoint', () => {
    const opened: LedgerEntry = {
      ...OWNER_FACT,
      kind: 'interval-open',
      eventId: 'interval-open-1',
      intervalId: 'interval-1',
      atMs: 100,
      cause: 'action-in-flight'
    }
    const checkpointed: LedgerEntry = {
      ...OWNER_FACT,
      kind: 'interval-checkpoint',
      eventId: 'interval-checkpoint-1',
      intervalId: 'interval-1',
      atMs: 200
    }
    const closed: LedgerEntry = {
      ...OWNER_FACT,
      kind: 'interval-close',
      eventId: 'interval-close-1',
      intervalId: 'interval-1',
      atMs: 150,
      closeReason: 'settled'
    }

    expect(
      deriveBudgetState(ledger(opened, checkpointed, closed), {
        wallClockActiveMs: 75,
        turns: null
      })
    ).toEqual({ activeMs: 100, turns: 0, exhausted: { kind: 'wall-clock' } })
  })
})
