import { describe, expect, it } from 'vitest'
import { shouldAppendActiveTimeCheckpoint } from './service-ledger'

describe('shouldAppendActiveTimeCheckpoint', () => {
  it('coalesces periodic ticks into one ledger row per minute', () => {
    // the sampling interval is 15s, so an unthrottled tick wrote four rows a minute
    expect(shouldAppendActiveTimeCheckpoint('tick', 15_000)).toBe(false)
    expect(shouldAppendActiveTimeCheckpoint('tick', 45_000)).toBe(false)
    expect(shouldAppendActiveTimeCheckpoint('tick', 59_999)).toBe(false)
    expect(shouldAppendActiveTimeCheckpoint('tick', 60_000)).toBe(true)
    expect(shouldAppendActiveTimeCheckpoint('tick', 120_000)).toBe(true)
  })

  it('always flushes an accrued span on pause and shutdown', () => {
    expect(shouldAppendActiveTimeCheckpoint('pause', 1)).toBe(true)
    expect(shouldAppendActiveTimeCheckpoint('shutdown', 1)).toBe(true)
  })
})
