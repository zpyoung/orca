import { getInFlightAttempts } from '../fork-heimdall/ledger-queries'
import type { PacingTier } from '../fork-heimdall/pacing'
import type { WatcherLedger } from '../fork-heimdall/ledger-types'
import type {
  HostedReviewCheckState,
  HostedReviewLifecycle,
  HostedReviewMergeMethod,
  HostedReviewProviderReadiness,
  HostedReviewQueueSnapshot,
  HostedReviewWorldSnapshot
} from './types'

export type HostedReviewTraceCheck = {
  checkKey: string
  name: string
  required: boolean
  state: HostedReviewCheckState
  headSha: string
  failureSignature: string | null
}

export type HostedReviewTraceSnapshot = {
  headSha: string
  baseSha: string
  lifecycle: HostedReviewLifecycle
  freshness: 'live' | 'cached'
  observedAtMs: number
  draft: boolean
  behindBase: boolean
  conflicts: 'none' | 'present' | 'unknown'
  checksComplete: boolean
  providerReadiness: HostedReviewProviderReadiness
  queue: HostedReviewQueueSnapshot
  defaultMergeMethod: HostedReviewMergeMethod
  checks: readonly HostedReviewTraceCheck[]
  /** Set instead of `checks` when a debug report folds older traces. */
  checkCounts?: Record<string, number>
}

export function describeHostedReviewSnapshot(
  snapshot: HostedReviewWorldSnapshot
): HostedReviewTraceSnapshot {
  const review = snapshot.world.review
  return {
    headSha: review.headSha,
    baseSha: review.baseSha,
    lifecycle: review.lifecycle,
    freshness: snapshot.freshness,
    observedAtMs: snapshot.observedAtMs,
    draft: review.draft,
    behindBase: review.behindBase,
    conflicts: review.conflicts,
    checksComplete: review.checksComplete,
    providerReadiness: review.providerReadiness,
    queue: review.queue,
    defaultMergeMethod: review.defaultMergeMethod,
    checks: review.checks.map((check) => ({
      checkKey: check.checkKey,
      name: check.name,
      required: check.required,
      state: check.state,
      headSha: check.headSha,
      failureSignature: check.failureSignature
    }))
  }
}

export function paceHostedReview(
  snapshot: HostedReviewWorldSnapshot,
  ledger: WatcherLedger
): PacingTier {
  const review = snapshot.world.review
  if (review.lifecycle !== 'open') {
    return 'stopped'
  }

  const currentRequired = review.checks.filter(
    (check) => check.required && check.headSha === review.headSha
  )
  const settling =
    currentRequired.some((check) => check.state === 'pending') ||
    review.queue.membership === 'enqueued' ||
    getInFlightAttempts(ledger).length > 0
  if (settling) {
    return 'rapid'
  }

  const actionable =
    currentRequired.some((check) => check.state === 'failed') ||
    review.conflicts === 'present' ||
    review.behindBase
  return actionable ? 'active' : 'idle'
}
