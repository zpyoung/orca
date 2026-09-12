import { describe, expect, it } from 'vitest'
import {
  deriveHostedReviewSitterPacing,
  SITTER_ERROR_BACKOFF_MAX_MS,
  SITTER_FULL_RESYNC_MS,
  SITTER_RAPID_POLL_MS
} from './pacing'
import type { HostedReviewSitterLedger, HostedReviewSnapshot } from './types'

const EMPTY_LEDGER: HostedReviewSitterLedger = { sitterId: 'sitter-1', entries: [] }

function review(overrides: Partial<HostedReviewSnapshot> = {}): HostedReviewSnapshot {
  return {
    provider: 'github',
    reviewNumber: 42,
    url: 'https://github.com/acme/repo/pull/42',
    lifecycle: 'open',
    headSha: 'head-1',
    baseSha: 'base-1',
    observedAtMs: SITTER_FULL_RESYNC_MS,
    freshness: 'live',
    draft: false,
    checks: [],
    checksComplete: true,
    providerReadiness: { verdict: 'blocked', blockers: ['approvals'] },
    behindBase: false,
    conflicts: 'none',
    queue: { required: false, membership: 'not-enqueued' },
    defaultMergeMethod: 'squash',
    ...overrides
  }
}

describe('PR sitter adaptive pacing', () => {
  it('polls rapidly while current-head checks are settling', () => {
    const settling = review({
      checks: [
        {
          checkKey: 'test',
          checkId: 'check-1',
          name: 'test',
          required: true,
          headSha: 'head-1',
          state: 'pending',
          observationId: 'test:1',
          failureSignature: null
        }
      ]
    })
    expect(
      deriveHostedReviewSitterPacing(settling, EMPTY_LEDGER, {
        consecutiveErrors: 0,
        lastFullResyncAtMs: 0
      })
    ).toMatchObject({ tier: 'rapid', delayMs: SITTER_RAPID_POLL_MS })
  })

  it('backs provider errors off on a capped axis independent of state tier', () => {
    const pacing = deriveHostedReviewSitterPacing(
      review({
        checks: [
          {
            checkKey: 'test',
            checkId: 'check-1',
            name: 'test',
            required: true,
            headSha: 'head-1',
            state: 'pending',
            observationId: 'test:1',
            failureSignature: null
          }
        ]
      }),
      EMPTY_LEDGER,
      { consecutiveErrors: 100, lastFullResyncAtMs: 0 }
    )
    expect(pacing).toMatchObject({
      tier: 'rapid',
      stateDelayMs: SITTER_RAPID_POLL_MS,
      errorBackoffMs: SITTER_ERROR_BACKOFF_MAX_MS,
      delayMs: SITTER_ERROR_BACKOFF_MAX_MS
    })
  })

  it('marks the periodic full-resync backstop due using explicit clock input', () => {
    const pacing = deriveHostedReviewSitterPacing(review(), EMPTY_LEDGER, {
      consecutiveErrors: 0,
      lastFullResyncAtMs: 500,
      evaluatedAtMs: 500 + SITTER_FULL_RESYNC_MS
    })
    expect(pacing.fullResyncDue).toBe(true)
    expect(pacing.nextFullResyncInMs).toBe(0)
  })
})
