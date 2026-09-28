import { deviationRetriesExhausted, type OwnerDeviationEscalation } from './deviation-ledger'
import { OWNER_STALL_THRESHOLD_MS } from './stall-detector'

export type OwnerFailureDecision =
  | { action: 'wait' }
  | { action: 're-wake' }
  | { action: 'park-to-human'; reason: string }

/**
 * A deviation is by definition something the deterministic layer could not resolve on its own, so
 * an owner that never answers escalates to a human rather than falling back to automatic replan —
 * that would silently reintroduce the plan-discarding behaviour the owner exists to replace.
 */
export function evaluateOwnerReachability(args: {
  deviation: OwnerDeviationEscalation
  ownerWokeAtMs: number
  nowMs: number
  thresholdMs?: number
}): OwnerFailureDecision {
  const threshold = args.thresholdMs ?? OWNER_STALL_THRESHOLD_MS
  if (args.nowMs - args.ownerWokeAtMs < threshold) {
    return { action: 'wait' }
  }
  if (deviationRetriesExhausted(args.deviation)) {
    return {
      action: 'park-to-human',
      reason: `The owning agent did not answer within ${threshold}ms after a bounded re-wake.`
    }
  }
  return { action: 're-wake' }
}
