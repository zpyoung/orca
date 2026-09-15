import type { ActionOutcome } from '../../shared/fork-heimdall/effect-certainty'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import type { ExecuteContext } from '../../shared/fork-heimdall/kind-contract'
import type { ObjectiveAction } from '../../shared/fork-heimdall-objective/objective-actions'
import type { ObjectivePlan } from '../../shared/fork-heimdall-objective/plan-schema'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import { deriveObjectiveBudgetBucket } from '../../shared/fork-heimdall-objective/pacing'
import type { Store } from '../persistence'
import { buildObjectiveRolePrompt, resolveObjectiveRoleAgent } from './role-prompts'
import { captureObjectiveWorkspaceBaseline } from './observed-workspace-changes'
import { issueObjectiveReportPath } from './report-ingestion'
import type { ObjectiveStore } from './objective-store'
import type { ObjectiveSnapshotBinding } from './execution-context'

type DispatchAction = Extract<ObjectiveAction, { kind: `dispatch-${string}` }>

type DispatchSpec = {
  role: 'planner' | 'implementer' | 'reviewer' | 'integrator'
  spec: string
  taskKey?: string
  deps?: string[]
}

function requirePlan(objectiveStore: ObjectiveStore, revisionId: string): ObjectivePlan {
  const plan = objectiveStore.getPlan(revisionId)
  if (!plan) {
    throw new Error(`Objective plan revision ${revisionId} is unavailable`)
  }
  return plan
}

function completedNodeDependencies(
  objectiveStore: ObjectiveStore,
  watcherId: string,
  revisionId: string,
  ledger: ExecuteContext<ObjectiveWorld>['ledger']
): string[] {
  const nodes = objectiveStore
    .project(watcherId, ledger)
    .nodes.filter((node) => node.revisionId === revisionId)
  const missing = nodes.find((node) => node.orchestrationTaskId === null)
  if (missing) {
    throw new Error(`Objective node ${missing.taskKey} has no orchestration task id`)
  }
  return nodes.map((node) => node.orchestrationTaskId as string)
}

function buildDispatchSpec(args: {
  action: DispatchAction
  binding: ObjectiveSnapshotBinding
  context: ExecuteContext<ObjectiveWorld>
  objectiveStore: ObjectiveStore
  reportPath: string
}): DispatchSpec {
  const { action, binding, context, objectiveStore, reportPath } = args
  const budgetBucket = deriveObjectiveBudgetBucket(context.ledger, binding.enrollment.budget)
  if (action.kind === 'dispatch-planner') {
    return {
      role: 'planner',
      taskKey: `objective-plan-${action.revisionNumber}`,
      spec: buildObjectiveRolePrompt({
        role: 'planner',
        contract: binding.contract,
        reportPath,
        budgetBucket,
        reason: action.reason
      })
    }
  }
  const plan = requirePlan(objectiveStore, action.revisionId)
  if (action.kind === 'dispatch-node') {
    const node = objectiveStore.getTask(action.revisionId, action.taskKey)
    if (!node) {
      throw new Error(`Objective task ${action.taskKey} is unavailable`)
    }
    return {
      role: 'implementer',
      taskKey: action.taskKey,
      deps: [...action.depsOrchestrationIds],
      spec: buildObjectiveRolePrompt({
        role: 'implementer',
        contract: binding.contract,
        plan,
        node,
        reportPath,
        budgetBucket
      })
    }
  }
  const role = action.kind === 'dispatch-reviewer' ? 'reviewer' : 'integrator'
  return {
    role,
    taskKey: `objective-${role}-${action.revisionId}`,
    deps: completedNodeDependencies(
      objectiveStore,
      binding.enrollment.watcherId,
      action.revisionId,
      context.ledger
    ),
    spec: buildObjectiveRolePrompt({
      role,
      contract: binding.contract,
      plan,
      reportPath,
      budgetBucket
    })
  }
}

export async function executeObjectiveDispatch(args: {
  action: DispatchAction
  binding: ObjectiveSnapshotBinding
  context: ExecuteContext<ObjectiveWorld>
  objectiveStore: ObjectiveStore
  store: Store
}): Promise<ActionOutcome> {
  const fingerprint = makeAttemptFingerprint(
    args.action.contentIdentity,
    args.action.kind,
    args.action.evidenceKey
  )
  await args.context.lease.assertHeld()
  let reportPath: string
  let request: DispatchSpec
  let agent: string
  try {
    reportPath = await issueObjectiveReportPath(args.binding.target, fingerprint)
    request = buildDispatchSpec({ ...args, reportPath })
    agent = resolveObjectiveRoleAgent(args.store, args.binding.contract, request.role)
    if (args.action.kind === 'dispatch-node' || args.action.kind === 'dispatch-integrator') {
      await captureObjectiveWorkspaceBaseline(args.binding.target, fingerprint)
    }
  } catch (error) {
    return {
      effect: 'not-landed',
      reason: error instanceof Error ? error.message : String(error)
    }
  }
  await args.context.lease.assertHeld()
  const result = await args.context.dispatchWorker({
    spec: request.spec,
    agent,
    ...(request.taskKey === undefined ? {} : { taskKey: request.taskKey }),
    ...(request.deps === undefined ? {} : { deps: request.deps })
  })
  if (result.status === 'refused') {
    return { effect: 'not-landed', reason: result.reason, result: { detail: result.detail } }
  }
  if (result.status === 'indeterminate') {
    return { effect: 'indeterminate', reason: 'dispatch-indeterminate', result }
  }
  return { effect: 'landed', result: { dispatchId: result.dispatchId, reportPath } }
}
