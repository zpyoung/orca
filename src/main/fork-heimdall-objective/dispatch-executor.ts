import type { ActionOutcome } from '../../shared/fork-heimdall/effect-certainty'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import type { ExecuteContext } from '../../shared/fork-heimdall/kind-contract'
import {
  activeObjectiveRevision,
  objectiveAttemptFailureClass,
  objectiveAttempts,
  projectObjectiveReports,
  requireObjectiveOriginalDispatchFingerprint,
  type ObjectiveAttempt
} from '../../shared/fork-heimdall-objective/decision-context'
import type { ObjectiveAction } from '../../shared/fork-heimdall-objective/objective-actions'
import type { ObjectivePlan } from '../../shared/fork-heimdall-objective/plan-schema'
import type {
  ObjectiveNodeState,
  ObjectivePendingReport,
  ObjectiveWorld
} from '../../shared/fork-heimdall-objective/detail-types'
import { deriveObjectiveBudgetBucket } from '../../shared/fork-heimdall-objective/pacing'
import type { Store } from '../persistence'
import {
  buildObjectiveRolePrompt,
  resolveObjectiveRoleAgent,
  type ObjectiveFailureContext
} from './role-prompts'
import { captureObjectiveWorkspaceBaseline } from './observed-workspace-changes'
import { issueObjectiveReportPath, readObjectiveRoleReport } from './report-ingestion'
import type { ObjectiveStore } from './objective-store'
import type { ObjectiveSnapshotBinding } from './execution-context'

type DispatchAction = Extract<ObjectiveAction, { kind: `dispatch-${string}` }>

type DispatchSpec = {
  role: 'planner' | 'implementer' | 'reviewer' | 'integrator'
  spec: string
  taskKey?: string
  deps?: string[]
}

const OBJECTIVE_FAILURE_NARRATIVE_MAX_CHARS = 4_096
const OBJECTIVE_FAILURE_CRITERIA_MAX_COUNT = 8
const OBJECTIVE_FAILURE_CRITERION_NOTE_MAX_CHARS = 512

function truncatedForPrompt(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value
}

function latestFailedDispatchNode(
  reports: readonly ObjectivePendingReport[],
  attempts: readonly ObjectiveAttempt[],
  activeRevisionId: string
): { report: ObjectivePendingReport; attempt: ObjectiveAttempt } | null {
  let latest: { report: ObjectivePendingReport; attempt: ObjectiveAttempt } | null = null
  for (const report of reports) {
    if (report.actionKind !== 'dispatch-node' || report.outcome !== 'failed') {
      continue
    }
    const matched = attempts.find((candidate) => candidate.attempt.dispatchId === report.dispatchId)
    if (
      !matched ||
      matched.action.kind !== 'dispatch-node' ||
      matched.action.revisionId !== activeRevisionId
    ) {
      continue
    }
    if (!latest || report.atMs > latest.report.atMs) {
      latest = { report, attempt: matched }
    }
  }
  return latest
}

async function failingCriteriaFromReport(args: {
  binding: ObjectiveSnapshotBinding
  objectiveStore: ObjectiveStore
  revisionId: string
  taskKey: string
  attemptFingerprint: string
  reportPath: string | null
}): Promise<string[]> {
  if (args.reportPath === null) {
    return []
  }
  try {
    const read = await readObjectiveRoleReport({
      target: args.binding.target,
      attemptFingerprint: args.attemptFingerprint,
      mailboxReportPath: args.reportPath,
      role: 'implementer',
      taskKey: args.taskKey
    })
    if (!read.ok) {
      return []
    }
    const task = args.objectiveStore.getTask(args.revisionId, args.taskKey)
    if (!task) {
      return []
    }
    return read.report.criteriaSelfAssessment
      .filter((assessment) => assessment.result === 'fail')
      .slice(0, OBJECTIVE_FAILURE_CRITERIA_MAX_COUNT)
      .map((assessment) => {
        const body =
          task.criteria[assessment.criterionIndex]?.body ?? `criterion ${assessment.criterionIndex}`
        return `${body} — ${truncatedForPrompt(assessment.note, OBJECTIVE_FAILURE_CRITERION_NOTE_MAX_CHARS)}`
      })
  } catch {
    return []
  }
}

/** Re-derived from the ledger on every dispatch; never persisted, so it can't go stale against it. */
export async function deriveObjectiveFailureContext(args: {
  action: Extract<ObjectiveAction, { kind: 'dispatch-planner' }>
  binding: ObjectiveSnapshotBinding
  ledger: ExecuteContext<ObjectiveWorld>['ledger']
  objectiveStore: ObjectiveStore
  activeRevisionId: string | undefined
}): Promise<ObjectiveFailureContext | undefined> {
  if (args.action.reason !== 'replan-after-failure' || args.activeRevisionId === undefined) {
    return undefined
  }
  try {
    const failed = latestFailedDispatchNode(
      projectObjectiveReports(args.ledger),
      objectiveAttempts(args.ledger),
      args.activeRevisionId
    )
    if (!failed || failed.attempt.action.kind !== 'dispatch-node') {
      return undefined
    }
    const failureClass = objectiveAttemptFailureClass(failed.attempt.attempt, args.ledger)
    const narrative = truncatedForPrompt(
      [failed.report.subject, failed.report.body]
        .filter((part): part is string => Boolean(part))
        .join('\n') || '(worker reported no narrative)',
      OBJECTIVE_FAILURE_NARRATIVE_MAX_CHARS
    )
    const failingCriteria = await failingCriteriaFromReport({
      binding: args.binding,
      objectiveStore: args.objectiveStore,
      revisionId: args.activeRevisionId,
      taskKey: failed.attempt.action.taskKey,
      attemptFingerprint: failed.attempt.attempt.fingerprint,
      reportPath: failed.report.reportPath
    })
    return {
      taskKey: failed.attempt.action.taskKey,
      ...(failureClass === undefined ? {} : { failureClass }),
      narrative,
      failingCriteria
    }
  } catch {
    return undefined
  }
}

function derivePlanProgress(
  objectiveStore: ObjectiveStore,
  watcherId: string,
  ledger: ExecuteContext<ObjectiveWorld>['ledger'],
  activeRevisionId: string | undefined
): readonly { taskKey: string; state: ObjectiveNodeState }[] | undefined {
  if (activeRevisionId === undefined) {
    return undefined
  }
  const nodes = objectiveStore
    .project(watcherId, ledger)
    .nodes.filter((node) => node.revisionId === activeRevisionId)
  return nodes.length > 0
    ? nodes.map((node) => ({ taskKey: node.taskKey, state: node.state }))
    : undefined
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
  failureContext?: ObjectiveFailureContext
  planProgress?: readonly { taskKey: string; state: ObjectiveNodeState }[]
}): DispatchSpec {
  const { action, binding, context, objectiveStore, reportPath, failureContext, planProgress } =
    args
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
        reason: action.reason,
        ...(failureContext === undefined ? {} : { failureContext }),
        ...(planProgress === undefined ? {} : { planProgress })
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
    const activeRevisionId =
      args.action.kind === 'dispatch-planner'
        ? activeObjectiveRevision(args.context.snapshot.world)?.id
        : undefined
    const failureContext =
      args.action.kind === 'dispatch-planner'
        ? await deriveObjectiveFailureContext({
            action: args.action,
            binding: args.binding,
            ledger: args.context.ledger,
            objectiveStore: args.objectiveStore,
            activeRevisionId
          })
        : undefined
    const planProgress =
      args.action.kind === 'dispatch-planner'
        ? derivePlanProgress(
            args.objectiveStore,
            args.binding.enrollment.watcherId,
            args.context.ledger,
            activeRevisionId
          )
        : undefined
    request = buildDispatchSpec({ ...args, reportPath, failureContext, planProgress })
    agent = resolveObjectiveRoleAgent(args.store, args.binding.contract, request.role)
    if (args.action.kind === 'dispatch-node' || args.action.kind === 'dispatch-integrator') {
      // a retry's baseline must stay the pre-original tree, not a fresh capture of its own fingerprint
      const baselineFingerprint =
        args.action.kind === 'dispatch-node' && args.action.retryOf !== undefined
          ? requireObjectiveOriginalDispatchFingerprint(args.context.ledger, args.action.retryOf)
          : fingerprint
      await captureObjectiveWorkspaceBaseline(args.binding.target, baselineFingerprint)
    }
  } catch (error) {
    return {
      effect: 'not-landed',
      failureClass: 'infra',
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
    return {
      effect: 'not-landed',
      failureClass: 'infra',
      reason: result.reason,
      result: { detail: result.detail }
    }
  }
  if (result.status === 'indeterminate') {
    return { effect: 'indeterminate', reason: 'dispatch-indeterminate', result }
  }
  return { effect: 'landed', result: { dispatchId: result.dispatchId, reportPath } }
}
