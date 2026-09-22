import { describe, expect, it } from 'vitest'
import type { OwnerDeviationEscalation } from './deviation-ledger'
import { evaluateOwnerReachability } from './owner-failure'

function escalation(foldCount: number): OwnerDeviationEscalation {
  return {
    eventId: 'event-1',
    watcherId: 'watcher-1',
    atMs: 0,
    origin: 'owner',
    class: 'fact',
    kind: 'escalation',
    escalationId: 'owner-deviation:watcher-1:worker-question:message-1',
    escalationKind: 'owner-deviation',
    status: 'open',
    foldCount
  }
}

describe('evaluateOwnerReachability', () => {
  it('waits while the threshold has not elapsed', () => {
    const decision = evaluateOwnerReachability({
      deviation: escalation(1),
      ownerWokeAtMs: 0,
      nowMs: 1_000,
      thresholdMs: 15 * 60_000
    })
    expect(decision).toEqual({ action: 'wait' })
  })

  it('re-wakes once past the threshold on the first turn', () => {
    const thresholdMs = 15 * 60_000
    const decision = evaluateOwnerReachability({
      deviation: escalation(1),
      ownerWokeAtMs: 0,
      nowMs: thresholdMs + 1,
      thresholdMs
    })
    expect(decision).toEqual({ action: 're-wake' })
  })

  it('parks to a human once the bounded re-wake is also unanswered', () => {
    const thresholdMs = 15 * 60_000
    const decision = evaluateOwnerReachability({
      deviation: escalation(2),
      ownerWokeAtMs: 0,
      nowMs: thresholdMs + 1,
      thresholdMs
    })
    expect(decision.action).toBe('park-to-human')
  })

  it('never proposes automatic replan as a decision', () => {
    const thresholdMs = 15 * 60_000
    for (const foldCount of [1, 2, 3]) {
      const decision = evaluateOwnerReachability({
        deviation: escalation(foldCount),
        ownerWokeAtMs: 0,
        nowMs: thresholdMs + 1,
        thresholdMs
      })
      expect(['wait', 're-wake', 'park-to-human']).toContain(decision.action)
    }
  })
})
