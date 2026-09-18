import {
  WORKER_EXITED_WITHOUT_COMPLETION,
  type ActionOutcome,
  type EffectCertainty,
  type EffectCertaintyResolution,
  type ObjectiveFailureClass
} from '../../shared/fork-heimdall/effect-certainty'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import { getLatestAttempts } from '../../shared/fork-heimdall/ledger-queries'
import type { ActionExecutor, LeaseGuard } from '../../shared/fork-heimdall/kind-contract'
import type { AttemptEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { LiveSnapshot, Snapshot } from '../../shared/fork-heimdall/snapshot'
import { requireObjectiveOriginalDispatchFingerprint } from '../../shared/fork-heimdall-objective/decision-context'
import {
  ObjectiveActionSchema,
  type ObjectiveAction
} from '../../shared/fork-heimdall-objective/objective-actions'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import {
  ImplementerReportSchema,
  parseAndValidateImplementerReport,
  parseAndValidateIntegratorReport,
  parseAndValidatePlannerReport,
  parseAndValidateReviewerReport
} from '../../shared/fork-heimdall-objective/plan-schema'
import type { Store } from '../persistence'
import type { ObjectiveForgeAccess } from './objective-forge-access'
import { executeObjectiveDispatch } from './dispatch-executor'
import {
  findObjectiveWorkerEvidence,
  requireObjectiveSnapshotBinding,
  type ObjectiveSnapshotBinding
} from './execution-context'
import { validateObjectiveWorkspaceChanges } from './observed-workspace-changes'
import { executeObjectiveLocalAction } from './local-action-executor'
import {
  executeCommitLocalBranch,
  executeOpenHostedReview,
  executePushRef
} from './landing-action-executor'
import { resolveLandingOutcome } from './landing-recovery'
import type { ObjectiveStore } from './objective-store'
import { readObjectiveRoleReport } from './report-ingestion'

type ObjectiveExecutorDependencies = {
  store: Store
  objectiveStore: ObjectiveStore
  snapshotBindings: WeakMap<Snapshot<ObjectiveWorld>, ObjectiveSnapshotBinding>
  forge: ObjectiveForgeAccess
}

function dispatchedTaskKeys(ledger: WatcherLedger): string[] {
  const keys = new Set<string>()
  for (const attempt of getLatestAttempts(ledger)) {
    const action = ObjectiveActionSchema.safeParse(attempt.action)
    if (action.success && action.data.kind === 'dispatch-node') {
      keys.add(action.data.taskKey)
    }
  }
  return [...keys]
}

type StoreLocalAction = Exclude<
  ObjectiveAction,
  {
    kind: `dispatch-${string}` | 'commit-local-branch' | 'push-ref' | 'open-hosted-review'
  }
>

function localActionOutcome(
  action: StoreLocalAction,
  binding: ObjectiveSnapshotBinding,
  objectiveStore: ObjectiveStore
): EffectCertainty {
  const watcherId = binding.enrollment.watcherId
  switch (action.kind) {
    case 'ingest-plan': {
      const revision = objectiveStore.planForDispatch(watcherId, action.dispatchId)
      return revision?.revisionNumber === action.revisionNumber ? 'landed' : 'not-landed'
    }
    case 'activate-plan':
      return objectiveStore.isPlanActivated(watcherId, action.revisionId, action.digest)
        ? 'landed'
        : 'not-landed'
    case 'ingest-report': {
      const node = objectiveStore.nodeForDispatch(watcherId, action.dispatchId)
      return node?.revisionId === action.revisionId && node.taskKey === action.taskKey
        ? 'landed'
        : 'not-landed'
    }
    case 'run-check': {
      const check = objectiveStore.getCheckAttempt(action.criterionId, action.contentIdentity)
      if (check === null) {
        return 'not-landed'
      }
      return check.completedAtMs !== null ? 'landed' : 'indeterminate'
    }
    case 'ingest-verdict':
      return objectiveStore.hasVerdict(action.dispatchId) ? 'landed' : 'not-landed'
    case 'record-landing':
      return objectiveStore.hasLanding(watcherId, action.rung, action.contentIdentity)
        ? 'landed'
        : 'not-landed'
  }
}

function validateResolvedDispatchReport(args: {
  action: Extract<ObjectiveAction, { kind: `dispatch-${string}` }>
  report: unknown
  evidenceFiles: readonly string[]
  binding: ObjectiveSnapshotBinding
  objectiveStore: ObjectiveStore
  ledger: WatcherLedger
}): boolean {
  const { action, report, binding, objectiveStore } = args
  try {
    if (action.kind === 'dispatch-planner') {
      parseAndValidatePlannerReport(report, {
        writeTerritory: binding.contract.writeTerritory,
        dispatchedTaskKeys: dispatchedTaskKeys(args.ledger)
      })
      return true
    }
    const plan = objectiveStore.getPlan(action.revisionId)
    if (!plan) {
      return false
    }
    if (action.kind === 'dispatch-node') {
      const task = objectiveStore.getTask(action.revisionId, action.taskKey)
      if (!task) {
        return false
      }
      const parsed = parseAndValidateImplementerReport(
        report,
        task,
        binding.contract.writeTerritory
      )
      return (
        [...parsed.filesModified].sort().join('\0') === [...args.evidenceFiles].sort().join('\0')
      )
    }
    if (action.kind === 'dispatch-reviewer') {
      parseAndValidateReviewerReport(report, plan)
    } else {
      parseAndValidateIntegratorReport(report, plan)
    }
    return true
  } catch {
    return false
  }
}

/** Only meaningful for a dispatch-node report; every other role has no per-criterion signal. */
function classifyValidatedReportFailure(
  report: unknown,
  action: Extract<ObjectiveAction, { kind: `dispatch-${string}` }>
): ObjectiveFailureClass {
  if (action.kind !== 'dispatch-node') {
    return 'criteria'
  }
  const parsed = ImplementerReportSchema.safeParse(report)
  if (!parsed.success) {
    return 'criteria'
  }
  const results = parsed.data.criteriaSelfAssessment.map((item) => item.result)
  if (results.some((result) => result === 'fail')) {
    return 'criteria'
  }
  return results.some((result) => result === 'unknown') ? 'environment' : 'criteria'
}

async function resolveDispatchOutcome(args: {
  attempt: AttemptEntry
  action: Extract<ObjectiveAction, { kind: `dispatch-${string}` }>
  ledger: WatcherLedger
  binding: ObjectiveSnapshotBinding
  objectiveStore: ObjectiveStore
}): Promise<EffectCertaintyResolution> {
  if (!args.attempt.dispatch) {
    return { effect: 'not-landed', failureClass: 'infra' }
  }
  const dispatchId = args.attempt.dispatchId
  if (!dispatchId) {
    return { effect: 'indeterminate' }
  }
  const evidence = findObjectiveWorkerEvidence(args.ledger, dispatchId)
  if (!evidence) {
    return args.attempt.reason === WORKER_EXITED_WITHOUT_COMPLETION
      ? { effect: 'not-landed', failureClass: 'infra' }
      : { effect: 'indeterminate' }
  }
  if (evidence.reportPath === null) {
    return { effect: 'not-landed', failureClass: 'criteria' }
  }
  const role =
    args.action.kind === 'dispatch-planner'
      ? 'planner'
      : args.action.kind === 'dispatch-node'
        ? 'implementer'
        : args.action.kind === 'dispatch-reviewer'
          ? 'reviewer'
          : 'integrator'
  try {
    const read = await readObjectiveRoleReport({
      target: args.binding.target,
      attemptFingerprint: args.attempt.fingerprint,
      mailboxReportPath: evidence.reportPath,
      role,
      ...(args.action.kind === 'dispatch-node' ? { taskKey: args.action.taskKey } : {})
    })
    if (!read.ok) {
      return { effect: 'not-landed', failureClass: 'criteria' }
    }
    if (
      !validateResolvedDispatchReport({
        ...args,
        report: read.report,
        evidenceFiles: evidence.filesModified
      })
    ) {
      return { effect: 'not-landed', failureClass: 'criteria' }
    }
    if (args.action.kind === 'dispatch-node' || args.action.kind === 'dispatch-integrator') {
      // a retry must diff against the pre-original baseline, not one keyed to its own fingerprint
      const baselineFingerprint =
        args.action.kind === 'dispatch-node' && args.action.retryOf !== undefined
          ? requireObjectiveOriginalDispatchFingerprint(args.ledger, args.action.retryOf)
          : args.attempt.fingerprint
      const observed = await validateObjectiveWorkspaceChanges({
        target: args.binding.target,
        attemptFingerprint: baselineFingerprint,
        reportedFiles: evidence.filesModified,
        writeTerritory: args.binding.contract.writeTerritory
      })
      if (!observed.ok) {
        return { effect: 'not-landed', failureClass: 'criteria' }
      }
    }
    if (evidence.outcome === 'failed') {
      return {
        effect: 'not-landed',
        failureClass: classifyValidatedReportFailure(read.report, args.action)
      }
    }
    return { effect: 'landed' }
  } catch (error) {
    // classification-only reads must not newly throw a failed dispatch out of recovery; a
    // succeeded outcome keeps its pre-existing propagation since landing must still be authoritative
    if (evidence.outcome === 'succeeded') {
      throw error
    }
    return { effect: 'not-landed', failureClass: 'criteria' }
  }
}

export function createObjectiveActionExecutor(
  dependencies: ObjectiveExecutorDependencies
): ActionExecutor<ObjectiveWorld, ObjectiveAction> {
  const landingDependencies = {
    objectiveStore: dependencies.objectiveStore,
    forge: dependencies.forge
  }
  return {
    execute(action, context): Promise<ActionOutcome> {
      const binding = requireObjectiveSnapshotBinding(
        dependencies.snapshotBindings,
        context.snapshot
      )
      if (action.kind.startsWith('dispatch-')) {
        return executeObjectiveDispatch({
          action: action as Extract<ObjectiveAction, { kind: `dispatch-${string}` }>,
          binding,
          context,
          objectiveStore: dependencies.objectiveStore,
          store: dependencies.store
        })
      }
      if (action.kind === 'commit-local-branch') {
        return executeCommitLocalBranch({ action, binding, context, ...landingDependencies })
      }
      if (action.kind === 'push-ref') {
        return executePushRef({ action, binding, context, ...landingDependencies })
      }
      if (action.kind === 'open-hosted-review') {
        return executeOpenHostedReview({ action, binding, context, ...landingDependencies })
      }
      return executeObjectiveLocalAction({
        action: action as StoreLocalAction,
        binding,
        context,
        objectiveStore: dependencies.objectiveStore
      })
    },
    resolveOutcome(
      attempt: AttemptEntry,
      fresh: LiveSnapshot<ObjectiveWorld>,
      ledger: WatcherLedger,
      lease: LeaseGuard
    ): EffectCertaintyResolution | Promise<EffectCertaintyResolution> {
      const binding = requireObjectiveSnapshotBinding(dependencies.snapshotBindings, fresh)
      const parsed = ObjectiveActionSchema.safeParse(attempt.action)
      if (
        !parsed.success ||
        attempt.fingerprint !==
          makeAttemptFingerprint(
            parsed.data.contentIdentity,
            parsed.data.kind,
            parsed.data.evidenceKey
          )
      ) {
        return { effect: 'indeterminate' }
      }
      if (
        parsed.data.kind === 'commit-local-branch' ||
        parsed.data.kind === 'push-ref' ||
        parsed.data.kind === 'open-hosted-review'
      ) {
        return resolveLandingOutcome({
          attempt,
          action: parsed.data,
          binding,
          ...landingDependencies,
          lease
        }).then((effect) => ({ effect }))
      }
      if (!parsed.data.kind.startsWith('dispatch-')) {
        return {
          effect: localActionOutcome(
            parsed.data as StoreLocalAction,
            binding,
            dependencies.objectiveStore
          )
        }
      }
      return resolveDispatchOutcome({
        attempt,
        action: parsed.data as Extract<ObjectiveAction, { kind: `dispatch-${string}` }>,
        ledger,
        binding,
        objectiveStore: dependencies.objectiveStore
      })
    }
  }
}
