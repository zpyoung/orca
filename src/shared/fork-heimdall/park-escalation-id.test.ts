import { describe, expect, it } from 'vitest'
import {
  parkEscalationId,
  parkedWorkerEscalationId,
  stopPredicateParkEscalationId,
  workerEscalationParkId
} from './park-escalation-id'
import type { WatcherParkReason } from './watcher-types'

describe('parkEscalationId', () => {
  it('delegates a stop-predicate park to its dedicated builder', () => {
    const reason: WatcherParkReason = {
      kind: 'stop-predicate',
      predicateId: 'closed',
      reason: 'review-closed'
    }
    expect(parkEscalationId('watcher-1', reason)).toBe(
      stopPredicateParkEscalationId('watcher-1', 'closed')
    )
  })

  it('delegates a worker-escalation park to its dedicated builder', () => {
    const reason: WatcherParkReason = {
      kind: 'worker-escalation',
      escalationId: 'escalation-1',
      messageId: 'message-1'
    }
    expect(parkEscalationId('watcher-1', reason)).toBe(
      workerEscalationParkId('watcher-1', 'escalation-1')
    )
  })

  it('embeds the exhaustion kind for a budget park', () => {
    const reason: WatcherParkReason = { kind: 'budget', exhaustion: { kind: 'turns' } }
    expect(parkEscalationId('watcher-1', reason)).toBe('park:watcher-1:budget:turns')
  })

  it('embeds the message id for a worker-question park', () => {
    const reason: WatcherParkReason = { kind: 'worker-question', messageId: 'message-1' }
    expect(parkEscalationId('watcher-1', reason)).toBe('park:watcher-1:worker-question:message-1')
  })

  it('embeds the escalation id for an owner-escalation park so it round-trips', () => {
    const reason: WatcherParkReason = {
      kind: 'owner-escalation',
      escalationId: 'escalation-9',
      reason: 'needs a person'
    }
    expect(parkEscalationId('watcher-1', reason)).toBe(
      'park:watcher-1:owner-escalation:escalation-9'
    )
  })

  it('has no detail for a configuration-error park', () => {
    const reason: WatcherParkReason = { kind: 'configuration-error', reason: 'bad config' }
    expect(parkEscalationId('watcher-1', reason)).toBe('park:watcher-1:configuration-error')
  })

  it('has no detail for a coordinator-seat-lost park', () => {
    const reason: WatcherParkReason = { kind: 'coordinator-seat-lost' }
    expect(parkEscalationId('watcher-1', reason)).toBe('park:watcher-1:coordinator-seat-lost')
  })
})

describe('parkedWorkerEscalationId', () => {
  it('inverts workerEscalationParkId', () => {
    const id = workerEscalationParkId('watcher-1', 'escalation-1')
    expect(parkedWorkerEscalationId('watcher-1', id)).toBe('escalation-1')
  })

  it('returns null for an id it did not build', () => {
    expect(parkedWorkerEscalationId('watcher-1', 'park:watcher-1:budget:turns')).toBeNull()
  })
})
