import { describe, expect, it } from 'vitest'
import { formatHostedReviewSitterDuration } from './hosted-review-sitter-format'

describe('formatHostedReviewSitterDuration', () => {
  it('reports a sub-minute checkpoint in seconds rather than rounding up to a minute', () => {
    // active-time checkpoints sample well under a minute; ceiling them to "1m" made the ledger
    // read as though a minute of budget was spent several times a minute.
    expect(formatHostedReviewSitterDuration(15_000)).toBe('15s')
    expect(formatHostedReviewSitterDuration(1_000)).toBe('1s')
    expect(formatHostedReviewSitterDuration(59_999)).toBe('60s')
  })

  it('reports zero-length spans as zero, not a minute', () => {
    expect(formatHostedReviewSitterDuration(0)).toBe('0s')
  })

  it('keeps whole-minute and hour formatting', () => {
    expect(formatHostedReviewSitterDuration(60_000)).toBe('1m')
    expect(formatHostedReviewSitterDuration(90_000)).toBe('2m')
    expect(formatHostedReviewSitterDuration(60 * 60_000)).toBe('1h')
    expect(formatHostedReviewSitterDuration(90 * 60_000)).toBe('1h 30m')
  })
})
