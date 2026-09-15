import { deriveBudgetState, type BudgetPolicy } from '../fork-heimdall/budget'
import { getInFlightAttempts, getLatestEscalations } from '../fork-heimdall/ledger-queries'
import type { WatcherLedger } from '../fork-heimdall/ledger-types'
import type { PacingTier } from '../fork-heimdall/pacing'
import type { Snapshot } from '../fork-heimdall/snapshot'
import { ObjectiveActionSchema } from './objective-actions'
import type { ObjectiveBudgetBucket, ObjectiveWorld } from './detail-types'

const TIGHT_BUDGET_RATIO = 0.5
const NEARLY_SPENT_BUDGET_RATIO = 0.85

export function deriveObjectiveBudgetBucket(
  ledger: WatcherLedger,
  policy: BudgetPolicy
): ObjectiveBudgetBucket {
  const state = deriveBudgetState(ledger, policy)
  if (state.exhausted) {
    return 'spent'
  }
  const ratios: number[] = []
  if (policy.wallClockActiveMs !== null) {
    ratios.push(policy.wallClockActiveMs === 0 ? 1 : state.activeMs / policy.wallClockActiveMs)
  }
  if (policy.turns !== null) {
    ratios.push(policy.turns === 0 ? 1 : state.turns / policy.turns)
  }
  const ratio = ratios.length === 0 ? 0 : Math.max(...ratios)
  if (ratio >= 1) {
    return 'spent'
  }
  if (ratio >= NEARLY_SPENT_BUDGET_RATIO) {
    return 'nearly-spent'
  }
  return ratio >= TIGHT_BUDGET_RATIO ? 'tight' : 'plenty'
}

export function paceObjective(
  snapshot: Snapshot<ObjectiveWorld>,
  ledger: WatcherLedger
): PacingTier {
  if (
    snapshot.world.plan.landing.some(
      (entry) =>
        entry.rung === 'files-on-disk' && entry.contentIdentity === snapshot.contentIdentity
    )
  ) {
    return 'stopped'
  }
  if (
    getInFlightAttempts(ledger).some((attempt) => {
      const action = ObjectiveActionSchema.safeParse(attempt.action)
      return action.success && action.data.kind.startsWith('dispatch-')
    })
  ) {
    return 'active'
  }
  if (
    getLatestEscalations(ledger).some(
      (entry) => entry.status === 'open' && entry.escalationKind === 'awaiting-approval'
    ) ||
    deriveObjectiveBudgetBucket(ledger, snapshot.world.budget) === 'spent'
  ) {
    return 'idle'
  }
  return 'rapid'
}

export const objectivePacing = { pace: paceObjective }
