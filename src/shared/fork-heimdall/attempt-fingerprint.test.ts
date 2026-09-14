import { describe, expect, it } from 'vitest'
import {
  getAttemptDisposition,
  inspectAttemptLedger,
  makeAttemptFingerprint
} from './attempt-fingerprint'
import { getInFlightAttempts } from './ledger-queries'
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
