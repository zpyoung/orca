import { describe, expect, it } from 'vitest'
import {
  getAttemptDisposition,
  inspectAttemptLedger,
  makeAttemptFingerprint
} from './attempt-fingerprint'
import { getInFlightAttempts, hasPendingAttemptOutcome } from './ledger-queries'
import type { EffectCertainty } from './effect-certainty'
import type { LedgerEntry, WatcherLedger } from './ledger-types'

const ACTION = {
  kind: 'publish',
  capability: 'publish',
  visibility: 'external' as const,
  contentIdentity: 'head-1',
  evidenceKey: 'failure-1',
  expectedState: { target: 'refs/heads/main', before: 'head-1' }
}

function recoveredLedger(effect: Exclude<EffectCertainty, 'indeterminate'>): WatcherLedger {
  const fingerprint = makeAttemptFingerprint('head-1', 'publish', 'failure-1')
  const entries: LedgerEntry[] = [
    {
      eventId: 'attempt-event-1',
      watcherId: 'watcher-1',
      atMs: 1,
      origin: 'owner',
      class: 'fact',
      kind: 'attempt',
      attemptId: 'attempt-1',
      fingerprint,
      action: ACTION,
      state: 'running'
    },
    {
      eventId: 'resolution-event-1',
      watcherId: 'watcher-1',
      atMs: 2,
      origin: 'owner',
      class: 'fact',
      kind: 'attempt-resolved',
      attemptId: 'attempt-1',
      effect,
      evidence: { observed: effect }
    }
  ]
  return { watcherId: 'watcher-1', entries }
}

describe('attempt recovery disposition', () => {
  it('lets recovered landed evidence override a stale running revision', () => {
    const ledger = recoveredLedger('landed')
    const fingerprint = makeAttemptFingerprint('head-1', 'publish', 'failure-1')

    expect(getAttemptDisposition(ledger, fingerprint)).toBe('completed')
    expect(inspectAttemptLedger(ledger, fingerprint)).toEqual({
      disposition: 'completed',
      hasInFlight: false,
      hasUnresolved: false
    })
    expect(getInFlightAttempts(ledger)).toEqual([])
  })

  it('lets recovered not-landed evidence make a stale running revision retryable', () => {
    const ledger = recoveredLedger('not-landed')
    const fingerprint = makeAttemptFingerprint('head-1', 'publish', 'failure-1')

    expect(getAttemptDisposition(ledger, fingerprint)).toBe('retryable-failure')
    expect(inspectAttemptLedger(ledger, fingerprint)).toEqual({
      disposition: 'retryable-failure',
      hasInFlight: false,
      hasUnresolved: false
    })
    expect(getInFlightAttempts(ledger)).toEqual([])
  })
})

describe('pending attempt outcome', () => {
  it('stays pending after indeterminate settlement until an explicit resolution', () => {
    const fingerprint = makeAttemptFingerprint('head-1', 'publish', 'failure-1')
    const unsettled: WatcherLedger = {
      watcherId: 'watcher-1',
      entries: [
        {
          eventId: 'attempt-event-1',
          watcherId: 'watcher-1',
          atMs: 1,
          origin: 'owner',
          class: 'fact',
          kind: 'attempt',
          attemptId: 'attempt-1',
          fingerprint,
          action: ACTION,
          state: 'settled',
          effect: 'indeterminate'
        }
      ]
    }
    expect(hasPendingAttemptOutcome(unsettled)).toBe(true)

    const resolved: WatcherLedger = {
      ...unsettled,
      entries: [
        ...unsettled.entries,
        {
          eventId: 'resolution-event-1',
          watcherId: 'watcher-1',
          atMs: 2,
          origin: 'owner',
          class: 'fact',
          kind: 'attempt-resolved',
          attemptId: 'attempt-1',
          effect: 'not-landed',
          evidence: { observed: 'not-landed' }
        }
      ]
    }
    expect(hasPendingAttemptOutcome(resolved)).toBe(false)
  })
})
