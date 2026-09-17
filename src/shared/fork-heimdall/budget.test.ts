import { describe, expect, it } from 'vitest'
import { deriveBudgetState, HEIMDALL_BUDGET_GENERATION_EVIDENCE_KIND } from './budget'
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

  it('charges only work opened or dispatched after the latest budget generation boundary', () => {
    const history = ledger(
      {
        ...OWNER_FACT,
        kind: 'interval-open',
        eventId: 'old-open',
        intervalId: 'old-interval',
        atMs: 100,
        cause: 'worker-dispatched'
      },
      {
        ...OWNER_FACT,
        kind: 'interval-checkpoint',
        eventId: 'old-checkpoint',
        intervalId: 'old-interval',
        atMs: 200
      },
      {
        ...OWNER_FACT,
        kind: 'turn',
        eventId: 'old-turn',
        dispatchKind: 'child',
        dispatchId: 'old-dispatch',
        atMs: 200
      },
      {
        ...OWNER_FACT,
        kind: 'attempt',
        eventId: 'old-attempt',
        attemptId: 'old-attempt',
        fingerprint: 'old-fingerprint',
        action: {
          kind: 'old-action',
          capability: 'write',
          visibility: 'local',
          contentIdentity: 'old-content',
          evidenceKey: 'old-evidence'
        },
        state: 'attempted',
        atMs: 210
      },
      {
        ...OWNER_FACT,
        kind: 'evidence',
        eventId: 'generation',
        evidenceKind: HEIMDALL_BUDGET_GENERATION_EVIDENCE_KIND,
        payload: { reason: 're-enrollment-after-explicit-disarm' },
        atMs: 250
      },
      {
        ...OWNER_FACT,
        kind: 'interval-close',
        eventId: 'old-late-close',
        intervalId: 'old-interval',
        closeReason: 'settled',
        atMs: 260
      },
      {
        ...OWNER_FACT,
        kind: 'turn',
        eventId: 'old-late-turn',
        dispatchKind: 'child',
        attemptId: 'old-attempt',
        dispatchId: 'old-late-dispatch',
        atMs: 260
      },
      {
        ...OWNER_FACT,
        kind: 'interval-open',
        eventId: 'new-open',
        intervalId: 'new-interval',
        atMs: 270,
        cause: 'action-in-flight'
      },
      {
        ...OWNER_FACT,
        kind: 'interval-close',
        eventId: 'new-close',
        intervalId: 'new-interval',
        closeReason: 'settled',
        atMs: 300
      },
      {
        ...OWNER_FACT,
        kind: 'turn',
        eventId: 'new-turn',
        dispatchKind: 'planner',
        dispatchId: 'new-dispatch',
        atMs: 300
      }
    )

    expect(
      deriveBudgetState(history, {
        wallClockActiveMs: 100,
        turns: 2
      })
    ).toEqual({ activeMs: 30, turns: 1, exhausted: null })
    expect(history.entries.map((entry) => entry.eventId)).toEqual([
      'old-open',
      'old-checkpoint',
      'old-turn',
      'old-attempt',
      'generation',
      'old-late-close',
      'old-late-turn',
      'new-open',
      'new-close',
      'new-turn'
    ])
  })
})
