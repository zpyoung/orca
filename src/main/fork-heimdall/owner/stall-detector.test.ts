import { describe, expect, it } from 'vitest'
import type {
  AttemptEntry,
  EvidenceEntry,
  WatcherLedger
} from '../../../shared/fork-heimdall/ledger-types'
import { detectStall } from './stall-detector'

function runningAttempt(atMs: number, dispatchId = 'dispatch-1'): AttemptEntry {
  return {
    eventId: 'attempt-event',
    watcherId: 'watcher-1',
    atMs,
    origin: 'owner',
    class: 'fact',
    kind: 'attempt',
    attemptId: 'attempt-1',
    fingerprint: 'fp-1',
    action: {
      kind: 'dispatch-node',
      capability: 'write',
      visibility: 'local',
      contentIdentity: 'revision-1',
      evidenceKey: 'evidence-1'
    },
    state: 'running',
    dispatchId
  }
}

function heartbeat(atMs: number, dispatchId: string): EvidenceEntry {
  return {
    eventId: `evidence-${atMs}`,
    watcherId: 'watcher-1',
    atMs,
    origin: 'owner',
    class: 'fact',
    kind: 'evidence',
    evidenceKind: 'orchestration-mailbox',
    payload: { type: 'heartbeat', payload: JSON.stringify({ dispatchId }) }
  }
}

function ledger(entries: WatcherLedger['entries']): WatcherLedger {
  return { watcherId: 'watcher-1', entries }
}

describe('detectStall', () => {
  it('is null when nothing is running', () => {
    expect(detectStall(ledger([]), 1_000_000)).toBeNull()
  })

  it('is null when the attempt has not been running long enough', () => {
    const found = detectStall(ledger([runningAttempt(0)]), 1_000, 15 * 60_000)
    expect(found).toBeNull()
  })

  it('fires once the attempt has run past the threshold with no progress', () => {
    const thresholdMs = 15 * 60_000
    const found = detectStall(ledger([runningAttempt(0)]), thresholdMs + 1, thresholdMs)
    expect(found).toEqual({
      kind: 'stall',
      what: 'dispatch-node',
      dispatchId: 'dispatch-1',
      inFlightSinceMs: 0,
      thresholdMs
    })
  })

  it('resets the clock on the latest heartbeat evidence for that dispatch', () => {
    const thresholdMs = 15 * 60_000
    const entries = [runningAttempt(0), heartbeat(thresholdMs - 1, 'dispatch-1')]
    expect(detectStall(ledger(entries), thresholdMs, thresholdMs)).toBeNull()
  })

  it('ignores heartbeats for a different dispatch', () => {
    const thresholdMs = 15 * 60_000
    const entries = [runningAttempt(0), heartbeat(thresholdMs - 1, 'dispatch-other')]
    const found = detectStall(ledger(entries), thresholdMs + 1, thresholdMs)
    expect(found?.inFlightSinceMs).toBe(0)
  })

  it('ignores an attempted (not yet running) attempt', () => {
    const attempted: AttemptEntry = { ...runningAttempt(0), state: 'attempted' }
    delete (attempted as { dispatchId?: string }).dispatchId
    expect(detectStall(ledger([attempted]), 1_000_000)).toBeNull()
  })
})
