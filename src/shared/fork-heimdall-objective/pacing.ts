import { deriveBudgetState, type BudgetPolicy } from '../fork-heimdall/budget'
import { getInFlightAttempts, getLatestEscalations } from '../fork-heimdall/ledger-queries'
import type { WatcherLedger } from '../fork-heimdall/ledger-types'
import type { PacingTier } from '../fork-heimdall/pacing'
import type { Snapshot } from '../fork-heimdall/snapshot'
import { ObjectiveActionSchema } from './objective-actions'
import type { ObjectiveBudgetBucket, ObjectiveWorld } from './detail-types'
import {
  OBJECTIVE_LANDING_LADDER,
  highestReachedRung,
  nextRung,
  stopRungForBar
} from './landing-ladder'

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
  const highest = highestReachedRung(snapshot.world.plan.landing, snapshot.contentIdentity)
  const stop = stopRungForBar(snapshot.world.contract.landingBar)
  if (
    highest !== null &&
    OBJECTIVE_LANDING_LADDER.indexOf(highest) >= OBJECTIVE_LANDING_LADDER.indexOf(stop)
  ) {
    return 'stopped'
  }
  let dispatchInFlight = false
  for (const attempt of getInFlightAttempts(ledger)) {
    const parsed = ObjectiveActionSchema.safeParse(attempt.action)
    if (!parsed.success) {
      continue
    }
    const action = parsed.data
    if (
      action.kind === 'commit-local-branch' ||
      action.kind === 'push-ref' ||
      action.kind === 'open-hosted-review'
    ) {
      return 'rapid'
    }
    dispatchInFlight ||= action.kind.startsWith('dispatch-')
  }
  if (dispatchInFlight) {
    return 'active'
  }
  if (highest !== null) {
    const next = nextRung(highest, snapshot.world.contract.landingBar)
    const context = snapshot.world.landingContext
    if (
      (next === 'committed-local-branch' &&
        (context.branch === null ||
          context.headSha === null ||
          context.worktreeContentDigest === null)) ||
      (next === 'pushed-ref' && context.pushTarget === null) ||
      (next === 'hosted-review' &&
        (context.hostedReview === null || context.hostedReview.base === null))
    ) {
      return 'idle'
    }
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
