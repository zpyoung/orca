import { describe, expect, it } from 'vitest'
import {
  derivePacing,
  HEIMDALL_ERROR_BACKOFF_MAX_MS,
  HEIMDALL_FULL_RESYNC_MS,
  HEIMDALL_RAPID_POLL_MS
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
})
