import { describe, expect, it } from 'vitest'
import { describeParkReason } from './park-reason-description'
import type { WatcherParkReason } from './watcher-types'

describe('describeParkReason', () => {
  it('returns the persisted reason text for a stop predicate', () => {
    const reason: WatcherParkReason = {
      kind: 'stop-predicate',
      predicateId: 'closed',
      reason: 'review-closed'
    }
    expect(describeParkReason(reason)).toBe('review-closed')
  })

  it('returns the persisted reason text for a configuration error', () => {
    const reason: WatcherParkReason = {
      kind: 'configuration-error',
      reason: 'Resolved Git authority changed after Heimdall enrollment'
    }
    expect(describeParkReason(reason)).toBe(
      'Resolved Git authority changed after Heimdall enrollment'
    )
  })

  it('returns the persisted reason text for an owner escalation', () => {
    const reason: WatcherParkReason = {
      kind: 'owner-escalation',
      escalationId: 'escalation-1',
      reason: 'The owner must resolve this before the watcher can continue'
    }
    expect(describeParkReason(reason)).toBe(
      'The owner must resolve this before the watcher can continue'
    )
  })

  it('returns the escalation detail for a worker escalation', () => {
    const reason: WatcherParkReason = {
      kind: 'worker-escalation',
      escalationId: 'escalation-9',
      messageId: 'message-1'
    }
    expect(describeParkReason(reason)).toBe('escalation-9')
  })

  it('falls back to the bare kind for a budget park', () => {
    const reason: WatcherParkReason = { kind: 'budget', exhaustion: { kind: 'turns' } }
    expect(describeParkReason(reason)).toBe('budget')
  })

  it('falls back to the bare kind for a worker question park', () => {
    const reason: WatcherParkReason = { kind: 'worker-question', messageId: 'message-1' }
    expect(describeParkReason(reason)).toBe('worker-question')
  })

  it('falls back to the bare kind for a lost coordinator seat', () => {
    const reason: WatcherParkReason = { kind: 'coordinator-seat-lost' }
    expect(describeParkReason(reason)).toBe('coordinator-seat-lost')
  })
})
