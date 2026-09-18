import { describe, expect, it } from 'vitest'
import {
  derivePacing,
  errorBackoffMs,
  gateHoldBackoffMs,
  HEIMDALL_ERROR_BACKOFF_MAX_MS,
  HEIMDALL_FULL_RESYNC_MS,
  HEIMDALL_RAPID_POLL_MS,
  PacingDecisionSchema
} from './pacing'

describe('Heimdall adaptive pacing', () => {
  it('polls rapidly when the kind selects the rapid tier', () => {
    expect(
      derivePacing('rapid', {
        consecutiveErrors: 0,
        lastFullResyncAtMs: 0,
        evaluatedAtMs: HEIMDALL_FULL_RESYNC_MS
      })
    ).toMatchObject({ tier: 'rapid', delayMs: HEIMDALL_RAPID_POLL_MS })
  })

  it('backs errors off on a capped axis independent of state tier', () => {
    expect(
      derivePacing('rapid', {
        consecutiveErrors: 100,
        lastFullResyncAtMs: 0,
        evaluatedAtMs: HEIMDALL_FULL_RESYNC_MS
      })
    ).toMatchObject({
      tier: 'rapid',
      stateDelayMs: HEIMDALL_RAPID_POLL_MS,
      errorBackoffMs: HEIMDALL_ERROR_BACKOFF_MAX_MS,
      delayMs: HEIMDALL_ERROR_BACKOFF_MAX_MS
    })
  })

  it('marks the periodic full-resync backstop due using explicit clock input', () => {
    const pacing = derivePacing('idle', {
      consecutiveErrors: 0,
      lastFullResyncAtMs: 500,
      evaluatedAtMs: 500 + HEIMDALL_FULL_RESYNC_MS
    })
    expect(pacing.fullResyncDue).toBe(true)
    expect(pacing.nextFullResyncInMs).toBe(0)
  })

  it('behaves exactly as today at zero gate holds, with or without the field present', () => {
    const withoutField = derivePacing('rapid', {
      consecutiveErrors: 0,
      lastFullResyncAtMs: 0,
      evaluatedAtMs: HEIMDALL_FULL_RESYNC_MS
    })
    const withZero = derivePacing('rapid', {
      consecutiveErrors: 0,
      consecutiveGateHolds: 0,
      lastFullResyncAtMs: 0,
      evaluatedAtMs: HEIMDALL_FULL_RESYNC_MS
    })
    expect(withoutField).toMatchObject({ gateHoldBackoffMs: null, delayMs: HEIMDALL_RAPID_POLL_MS })
    expect(withZero).toMatchObject({ gateHoldBackoffMs: null, delayMs: HEIMDALL_RAPID_POLL_MS })
  })

  it('ramps the gate-hold backoff exactly like the error backoff, on the same capped axis', () => {
    for (const holds of [1, 2, 3, 6, 100]) {
      expect(gateHoldBackoffMs(holds)).toBe(errorBackoffMs(holds))
    }
    expect(gateHoldBackoffMs(100)).toBe(HEIMDALL_ERROR_BACKOFF_MAX_MS)
  })

  it('never lets a gate-hold backoff shorten a delay the state tier or error backoff already made longer', () => {
    const pacedByState = derivePacing('idle', {
      consecutiveErrors: 0,
      consecutiveGateHolds: 1,
      lastFullResyncAtMs: 0,
      evaluatedAtMs: 0
    })
    expect(pacedByState.delayMs).toBe(pacedByState.stateDelayMs)

    const pacedByError = derivePacing('rapid', {
      consecutiveErrors: 100,
      consecutiveGateHolds: 1,
      lastFullResyncAtMs: 0,
      evaluatedAtMs: 0
    })
    expect(pacedByError.delayMs).toBe(HEIMDALL_ERROR_BACKOFF_MAX_MS)

    const pacedByGateHold = derivePacing('rapid', {
      consecutiveErrors: 1,
      consecutiveGateHolds: 100,
      lastFullResyncAtMs: 0,
      evaluatedAtMs: 0
    })
    expect(pacedByGateHold.delayMs).toBe(HEIMDALL_ERROR_BACKOFF_MAX_MS)
  })

  it('parses a pre-existing persisted decision that predates the gate-hold field', () => {
    const legacy = {
      tier: 'rapid',
      delayMs: HEIMDALL_RAPID_POLL_MS,
      stateDelayMs: HEIMDALL_RAPID_POLL_MS,
      errorBackoffMs: null,
      fullResyncDue: false,
      nextFullResyncInMs: HEIMDALL_FULL_RESYNC_MS
    }
    expect(() => PacingDecisionSchema.parse(legacy)).not.toThrow()
    expect(PacingDecisionSchema.parse(legacy).gateHoldBackoffMs).toBeUndefined()
  })
})
