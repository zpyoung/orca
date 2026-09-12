import { getInFlightActions } from './ledger'
import type { HostedReviewSitterLedger, HostedReviewSnapshot } from './types'

export const SITTER_RAPID_POLL_MS = 15_000
export const SITTER_ACTIVE_POLL_MS = 60_000
export const SITTER_IDLE_POLL_MS = 5 * 60_000
export const SITTER_FULL_RESYNC_MS = 15 * 60_000
export const SITTER_ERROR_BACKOFF_BASE_MS = 30_000
export const SITTER_ERROR_BACKOFF_MAX_MS = 15 * 60_000

export type HostedReviewSitterPacingTier = 'rapid' | 'active' | 'idle' | 'stopped'

export type HostedReviewSitterPacingInput = {
  consecutiveErrors: number
  lastFullResyncAtMs: number | null
  /** Explicit clock input; defaults to the provider observation on successful ticks. */
  evaluatedAtMs?: number
}

export type HostedReviewSitterPacing = {
  tier: HostedReviewSitterPacingTier
  delayMs: number | null
  stateDelayMs: number | null
  errorBackoffMs: number | null
  fullResyncDue: boolean
  nextFullResyncInMs: number
}

export function hostedReviewSitterErrorBackoffMs(consecutiveErrors: number): number | null {
  if (consecutiveErrors <= 0) {
    return null
  }
  const exponent = Math.min(Math.max(0, consecutiveErrors - 1), 5)
  return Math.min(SITTER_ERROR_BACKOFF_MAX_MS, SITTER_ERROR_BACKOFF_BASE_MS * 2 ** exponent)
}

function stateTier(
  review: HostedReviewSnapshot,
  ledger: HostedReviewSitterLedger
): { tier: HostedReviewSitterPacingTier; delayMs: number | null } {
  if (review.lifecycle !== 'open') {
    return { tier: 'stopped', delayMs: null }
  }

  const currentRequired = review.checks.filter(
    (check) => check.required && check.headSha === review.headSha
  )
  const settling =
    currentRequired.some((check) => check.state === 'pending') ||
    review.queue.membership === 'enqueued' ||
    getInFlightActions(ledger).length > 0
  if (settling) {
    return { tier: 'rapid', delayMs: SITTER_RAPID_POLL_MS }
  }

  const actionable =
    currentRequired.some((check) => check.state === 'failed') ||
    review.conflicts === 'present' ||
    review.behindBase
  if (actionable) {
    return { tier: 'active', delayMs: SITTER_ACTIVE_POLL_MS }
  }
  return { tier: 'idle', delayMs: SITTER_IDLE_POLL_MS }
}

export function deriveHostedReviewSitterPacing(
  review: HostedReviewSnapshot,
  ledger: HostedReviewSitterLedger,
  input: HostedReviewSitterPacingInput
): HostedReviewSitterPacing {
  const state = stateTier(review, ledger)
  const errorBackoffMs = hostedReviewSitterErrorBackoffMs(input.consecutiveErrors)
  const evaluatedAtMs = input.evaluatedAtMs ?? review.observedAtMs
  const elapsedSinceFullResync =
    input.lastFullResyncAtMs === null
      ? SITTER_FULL_RESYNC_MS
      : Math.max(0, evaluatedAtMs - input.lastFullResyncAtMs)
  const nextFullResyncInMs = Math.max(0, SITTER_FULL_RESYNC_MS - elapsedSinceFullResync)
  const delayMs =
    state.delayMs === null
      ? null
      : errorBackoffMs === null
        ? state.delayMs
        : Math.max(state.delayMs, errorBackoffMs)

  return {
    tier: state.tier,
    delayMs,
    stateDelayMs: state.delayMs,
    errorBackoffMs,
    fullResyncDue: nextFullResyncInMs === 0,
    nextFullResyncInMs
  }
}
