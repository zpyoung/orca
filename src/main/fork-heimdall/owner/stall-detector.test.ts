import { describe, expect, it } from 'vitest'
import type {
  AttemptEntry,
  EscalationEntry,
  EvidenceEntry,
  WatcherLedger
} from '../../../shared/fork-heimdall/ledger-types'
import type { StallDeviation } from '../../../shared/fork-heimdall/owner/deviation'
import { ownerDeviationEscalationId } from './deviation-ledger'
import { detectStall } from './stall-detector'

function runningAttempt(atMs: number, dispatchId = 'dispatch-1'): AttemptEntry {
  return {
    eventId: `attempt-event-${dispatchId}`,
    watcherId: 'watcher-1',
    atMs,
    origin: 'owner',
    class: 'fact',
    kind: 'attempt',
    attemptId: `attempt-${dispatchId}`,
    fingerprint: `fp-${dispatchId}`,
    action: {
      kind: 'dispatch-node',
      capability: 'write',
      visibility: 'local',
      contentIdentity: 'revision-1',
      evidenceKey: `evidence-${dispatchId}`
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

function resolvedStall(atMs: number, dispatchId = 'dispatch-1'): EscalationEntry {
  const deviation: StallDeviation = {
    kind: 'stall',
    what: 'dispatch-node',
    dispatchId,
    inFlightSinceMs: 0,
    thresholdMs: 100
  }
  return {
    eventId: `resolved-${dispatchId}-${atMs}`,
    watcherId: 'watcher-1',
    atMs,
    origin: 'owner',
    class: 'fact',
    kind: 'escalation',
    escalationId: ownerDeviationEscalationId('watcher-1', deviation),
    escalationKind: 'owner-deviation',
    status: 'resolved',
    foldCount: 2
  }
}

function escalatedStall(atMs: number, dispatchId = 'dispatch-1'): EscalationEntry {
  const deviation: StallDeviation = {
    kind: 'stall',
    what: 'dispatch-node',
    dispatchId,
    inFlightSinceMs: 0,
    thresholdMs: 100
  }
  return {
    eventId: `escalated-${dispatchId}-${atMs}`,
    watcherId: 'watcher-1',
    atMs,
    origin: 'owner',
    class: 'fact',
    kind: 'escalation',
    escalationId: ownerDeviationEscalationId('watcher-1', deviation),
    escalationKind: 'owner-deviation',
    status: 'escalated',
    foldCount: 1
  }
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

  it('waits two thresholds after one resolution and four after the next', () => {
    const thresholdMs = 100
    const firstResolved = resolvedStall(200)
    let entries: WatcherLedger['entries'] = [runningAttempt(0), firstResolved]
    expect(
      detectStall(ledger(entries), firstResolved.atMs + 2 * thresholdMs - 1, thresholdMs)
    ).toBeNull()
    expect(
      detectStall(ledger(entries), firstResolved.atMs + 2 * thresholdMs, thresholdMs)
    ).toMatchObject({ dispatchId: 'dispatch-1' })

    const secondResolved = resolvedStall(401)
    entries = [...entries, secondResolved]
    expect(
      detectStall(ledger(entries), secondResolved.atMs + 4 * thresholdMs - 1, thresholdMs)
    ).toBeNull()
    expect(
      detectStall(ledger(entries), secondResolved.atMs + 4 * thresholdMs, thresholdMs)
    ).toMatchObject({ dispatchId: 'dispatch-1' })
  })

  it('caps resolved-stall backoff at eight thresholds', () => {
    const thresholdMs = 100
    const entries: WatcherLedger['entries'] = [
      runningAttempt(0),
      ...Array.from({ length: 5 }, (_, index) => resolvedStall((index + 1) * thresholdMs))
    ]
    const resolvedAt = 5 * thresholdMs
    expect(detectStall(ledger(entries), resolvedAt + 8 * thresholdMs - 1, thresholdMs)).toBeNull()
    expect(detectStall(ledger(entries), resolvedAt + 8 * thresholdMs, thresholdMs)).toMatchObject({
      dispatchId: 'dispatch-1'
    })
  })

  it('continues to another stalled dispatch while the first is backed off', () => {
    const found = detectStall(
      ledger([
        runningAttempt(0, 'dispatch-1'),
        runningAttempt(0, 'dispatch-2'),
        resolvedStall(200, 'dispatch-1')
      ]),
      250,
      100
    )
    expect(found?.dispatchId).toBe('dispatch-2')
  })

  it('does not apply a resolved escalation for another dispatch', () => {
    const found = detectStall(
      ledger([runningAttempt(0, 'dispatch-1'), resolvedStall(200, 'dispatch-other')]),
      1_000,
      100
    )
    expect(found?.dispatchId).toBe('dispatch-1')
  })

  it('does not return an already-escalated stall', () => {
    const found = detectStall(
      ledger([runningAttempt(0, 'dispatch-1'), escalatedStall(200, 'dispatch-1')]),
      1_000,
      100
    )
    expect(found).toBeNull()
  })

  it('continues to another stalled dispatch when the first is escalated', () => {
    const found = detectStall(
      ledger([
        runningAttempt(0, 'dispatch-1'),
        runningAttempt(0, 'dispatch-2'),
        escalatedStall(200, 'dispatch-1')
      ]),
      250,
      100
    )
    expect(found?.dispatchId).toBe('dispatch-2')
  })

  it('ignores an attempted (not yet running) attempt', () => {
    const attempted: AttemptEntry = { ...runningAttempt(0), state: 'attempted' }
    delete (attempted as { dispatchId?: string }).dispatchId
    expect(detectStall(ledger([attempted]), 1_000_000)).toBeNull()
  })
})
