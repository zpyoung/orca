import type { HostedReviewSitterCapabilities } from '../fork-hosted-review-sitter/types'
import type { BudgetPolicy, BudgetState } from '../fork-heimdall/budget'
import type { EnrollInput, WatcherEnrollment } from '../fork-heimdall/watcher-types'
import type {
  ObjectiveEnrollmentPayload,
  ObjectiveLandingBar,
  ObjectiveSitterOverrides
} from './contract-types'
import type { ObjectivePlan } from './plan-schema'

export type HostedReviewLandingPayload = {
  revisionId: string
  fromContentIdentity: string
  provider: 'github' | 'gitlab'
  reviewNumber: number
  reviewUrl: string
  branch: string
  headSha: string
  base: string
}

export type HandoffEvidencePayload = {
  sitterWatcherId: string
  reviewUrl: string
  reachedRung: 'hosted-review'
  contentIdentity: string
}

export type HandoffOriginPayload = {
  objectiveWatcherId: string
  objectiveTerminalEventId: string
  contentIdentity: string
  reachedRung: 'hosted-review'
  inheritedBudget: BudgetPolicy
  derivedCapabilities: HostedReviewSitterCapabilities
}

export function deriveSitterCapabilities(
  bar: ObjectiveLandingBar,
  overrides: ObjectiveSitterOverrides
): HostedReviewSitterCapabilities {
  const capabilities: HostedReviewSitterCapabilities = {
    updateBranch: 'gated',
    resolveConflicts: 'off',
    fixChecks: 'gated',
    merge: bar === 'merged' ? 'gated' : 'off'
  }
  if (overrides.updateBranch !== undefined) {
    capabilities.updateBranch = overrides.updateBranch
  }
  if (overrides.resolveConflicts !== undefined) {
    capabilities.resolveConflicts = overrides.resolveConflicts
  }
  if (overrides.fixChecks !== undefined) {
    capabilities.fixChecks = overrides.fixChecks
  }
  if (overrides.merge !== undefined) {
    capabilities.merge = overrides.merge === 'on' ? 'gated' : overrides.merge
  }
  return capabilities
}

export function remainingBudget(policy: BudgetPolicy, state: BudgetState): BudgetPolicy {
  return {
    wallClockActiveMs:
      policy.wallClockActiveMs === null
        ? null
        : Math.max(0, policy.wallClockActiveMs - state.activeMs),
    turns: policy.turns === null ? null : Math.max(0, policy.turns - state.turns)
  }
}

export function deriveHandoffInput(args: {
  enrollment: WatcherEnrollment
  contract: ObjectiveEnrollmentPayload
  landing: HostedReviewLandingPayload
  budgetState: BudgetState
}): EnrollInput {
  return {
    kind: 'hosted-review',
    repoId: args.enrollment.repoId,
    worktreeId: args.enrollment.worktreeId,
    capabilities: deriveSitterCapabilities(args.contract.landingBar, args.contract.sitterOverrides),
    budget: remainingBudget(args.enrollment.budget, args.budgetState),
    kindPayload: {
      branch: args.landing.branch,
      provider: args.landing.provider,
      reviewNumber: args.landing.reviewNumber,
      reviewUrl: args.landing.reviewUrl,
      branchUpdateMode: 'merge-base-update',
      mergeMethod: null,
      mergeCheckScope: 'all'
    }
  }
}

export function renderReviewBody(
  contract: ObjectiveEnrollmentPayload,
  plan: ObjectivePlan
): string {
  const criteria = plan.flatMap((task) =>
    task.criteria.map((criterion) => `- ${task.title}: ${criterion.body}`)
  )
  return `${contract.objectiveText}\n\n## Acceptance criteria\n\n${criteria.join('\n')}`
}
