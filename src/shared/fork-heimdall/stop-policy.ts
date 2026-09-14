import { z } from 'zod'
import type { Snapshot } from './snapshot'
import type { WatcherLedger } from './ledger-types'

export const StopVerdictSchema = z.discriminatedUnion('stop', [
  z.object({ stop: z.literal(false) }).strict(),
  z
    .object({
      stop: z.literal(true),
      reason: z.string().trim().min(1),
      detail: z.string().optional()
    })
    .strict()
])
export type StopVerdict = z.infer<typeof StopVerdictSchema>

export type StopPredicate<TWorld> = {
  id: string
  evaluate(snapshot: Snapshot<TWorld>, ledger: WatcherLedger): StopVerdict
}

export type FiredStopPredicate = {
  predicateId: string
  reason: string
  detail?: string
}

/** Returns the first registered fatal predicate, preserving kind declaration order. */
export function evaluateStopPredicates<TWorld>(
  predicates: readonly StopPredicate<TWorld>[],
  snapshot: Snapshot<TWorld>,
  ledger: WatcherLedger
): FiredStopPredicate | null {
  for (const predicate of predicates) {
    const verdict = predicate.evaluate(snapshot, ledger)
    if (verdict.stop) {
      return {
        predicateId: predicate.id,
        reason: verdict.reason,
        ...(verdict.detail === undefined ? {} : { detail: verdict.detail })
      }
    }
  }
  return null
}
