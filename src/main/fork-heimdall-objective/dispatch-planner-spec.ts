import type { ExecuteContext } from '../../shared/fork-heimdall/kind-contract'
import { latestObjectivePlanReviewForPlannerDispatch } from '../../shared/fork-heimdall-objective/decide-plan-review'
import { objectiveAttempts } from '../../shared/fork-heimdall-objective/decision-context'
import type {
  ObjectiveBudgetBucket,
  ObjectiveNodeState,
  ObjectiveWorld
} from '../../shared/fork-heimdall-objective/detail-types'
import type { ObjectiveAction } from '../../shared/fork-heimdall-objective/objective-actions'
import type { RepairPlanContext } from './repair-plan-context'
import type { ObjectiveFailureContext } from './role-prompts'
import { buildObjectiveRolePrompt } from './role-prompts'
import type { ObjectiveSnapshotBinding } from './execution-context'
import type { ObjectiveStore } from './objective-store'

const PLAN_REVIEW_FINDINGS_MAX_CHARS = 8_000

function objectivePlannerReviewFindings(
  action: Extract<ObjectiveAction, { kind: 'dispatch-planner' }>,
  context: ExecuteContext<ObjectiveWorld>,
  objectiveStore: ObjectiveStore
): string | undefined {
  const review = latestObjectivePlanReviewForPlannerDispatch(
    context.snapshot.world,
    objectiveAttempts(context.ledger),
    action
  )
  if (!review || review.verdict !== 'revise') {
    return undefined
  }
  const report = objectiveStore.getPlanReviewReport(review.id)
  if (!report) {
    return undefined
  }
  const lines = [report.summary]
  for (const finding of report.findings) {
    if (finding.severity === 'blocking') {
      lines.push(`${finding.taskKey ?? '(plan)'}: ${finding.body}`)
    }
  }
  for (const assessment of report.assumptions) {
    if (assessment.status === 'unverified') {
      lines.push(`assumption[${assessment.index}]: ${assessment.evidence}`)
    }
  }
  return lines.join('\n').slice(0, PLAN_REVIEW_FINDINGS_MAX_CHARS)
}

/** Assembles a `dispatch-planner` action's worker dispatch spec, folding in a prior review's findings. */
export function buildObjectivePlannerDispatchSpec(args: {
  action: Extract<ObjectiveAction, { kind: 'dispatch-planner' }>
  binding: ObjectiveSnapshotBinding
  context: ExecuteContext<ObjectiveWorld>
  objectiveStore: ObjectiveStore
  reportPath: string
  budgetBucket: ObjectiveBudgetBucket
  effectiveMaxConcurrency: number
  lanesEnabled: boolean
  failureContext?: ObjectiveFailureContext
  planProgress?: readonly { taskKey: string; state: ObjectiveNodeState }[]
  repairContext?: RepairPlanContext
}): { role: 'planner'; taskKey: string; spec: string } {
  const { action, binding, context, objectiveStore } = args
  const findings = objectivePlannerReviewFindings(action, context, objectiveStore)
  return {
    role: 'planner',
    taskKey: `objective-plan-${action.revisionNumber}`,
    spec: buildObjectiveRolePrompt({
      role: 'planner',
      contract: binding.contract,
      reportPath: args.reportPath,
      budgetBucket: args.budgetBucket,
      effectiveMaxConcurrency: args.effectiveMaxConcurrency,
      lanesEnabled: args.lanesEnabled,
      reason: action.reason,
      ...(args.failureContext === undefined ? {} : { failureContext: args.failureContext }),
      ...(args.planProgress === undefined ? {} : { planProgress: args.planProgress }),
      ...(action.requestedSkipStage === undefined
        ? {}
        : { requestedSkipStage: action.requestedSkipStage }),
      ...(action.guidance === undefined ? {} : { ownerGuidance: action.guidance }),
      ...(action.shape === undefined ? {} : { shape: action.shape }),
      ...(args.repairContext === undefined ? {} : { repairContext: args.repairContext }),
      ...(findings === undefined ? {} : { planReviewFindings: findings })
    })
  }
}
