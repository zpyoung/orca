import { z } from 'zod'
import type { Snapshot } from './snapshot'
import type { WatcherLedger } from './ledger-types'
import type { Deviation } from './owner/deviation'

export const StopDispositionSchema = z.enum(['park', 'terminal'])
export type StopDisposition = z.infer<typeof StopDispositionSchema>

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
export type FiredStopVerdict = Extract<StopVerdict, { stop: true }>

export type StopPredicate<TWorld> = {
  id: string
  disposition?: StopDisposition
  evaluate(snapshot: Snapshot<TWorld>, ledger: WatcherLedger): StopVerdict
  /**
   * Opts a `park`-disposition predicate into owner routing: when the firing watcher has an owner
   * configured, this builds the deviation it is woken with instead of parking. Never consulted for
   * a `terminal` disposition. A predicate that omits this always parks, exactly as before this
   * existed — the kernel only calls it when a kind explicitly supplies it.
   */
  deviationForFiring?(
    verdict: FiredStopVerdict,
    snapshot: Snapshot<TWorld>,
    ledger: WatcherLedger
  ): Deviation
}

export type FiredStopPredicate = {
  predicateId: string
  disposition: StopDisposition
  reason: string
  detail?: string
  /** Present only when the firing predicate supplied `deviationForFiring`. */
  deviation?: Deviation
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
        disposition: predicate.disposition ?? 'park',
        reason: verdict.reason,
        ...(verdict.detail === undefined ? {} : { detail: verdict.detail }),
        ...(predicate.deviationForFiring
          ? { deviation: predicate.deviationForFiring(verdict, snapshot, ledger) }
          : {})
      }
    }
  }
  return null
}
