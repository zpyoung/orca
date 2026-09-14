import { describe, expect, it } from 'vitest'
import {
  countChecksByState,
  createTickTrace,
  pushTickTrace,
  type WatcherTickTrace
} from './tick-trace'

const RUNNER: WatcherTickTrace['runner'] = {
  consecutiveErrors: 0,
  lastFullResyncAtMs: null,
  reconcileAgain: false
}

function trace(seq: number): WatcherTickTrace {
  return createTickTrace(seq, seq * 1_000, RUNNER)
}

describe('Heimdall tick-trace ring', () => {
  it('evicts the oldest past capacity and preserves order', () => {
    const ring: WatcherTickTrace[] = []
    for (let seq = 1; seq <= 6; seq += 1) {
      pushTickTrace(ring, trace(seq), 4)
    }
    expect(ring.map((entry) => entry.seq)).toEqual([3, 4, 5, 6])
  })

  it('never evicts a pinned trace while reclaimable traces remain', () => {
    const pinned = trace(1)
    pinned.pinned = true
    const ring = [pinned, trace(2), trace(3)]
    pushTickTrace(ring, trace(4), 3)
    expect(ring.map((entry) => entry.seq)).toEqual([1, 3, 4])
  })

  it('exposes a tick that has not finished yet', () => {
    const ring: WatcherTickTrace[] = []
    const inFlight = trace(1)
    pushTickTrace(ring, inFlight)

    expect(ring[0]?.exitPath).toBeNull()
    expect(ring[0]?.durationMs).toBeNull()

    inFlight.exitPath = 'acted'
    inFlight.durationMs = 42
    expect(ring[0]?.exitPath).toBe('acted')
    expect(ring[0]?.durationMs).toBe(42)
  })

  it('counts checks by requirement and state for kind snapshot summaries', () => {
    expect(
      countChecksByState([
        { required: true, state: 'failed' },
        { required: true, state: 'failed' },
        { required: false, state: 'passed' }
      ])
    ).toEqual({ 'required:failed': 2, 'optional:passed': 1 })
  })
})
