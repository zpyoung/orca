import type { ActionOutcome, EffectCertainty } from '../../shared/fork-heimdall/effect-certainty'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import { getLatestAttempts } from '../../shared/fork-heimdall/ledger-queries'
import type { ActionExecutor } from '../../shared/fork-heimdall/kind-contract'
import type { AttemptEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { LiveSnapshot, Snapshot } from '../../shared/fork-heimdall/snapshot'
import {
  ObjectiveActionSchema,
  type ObjectiveAction
} from '../../shared/fork-heimdall-objective/objective-actions'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import {
  parseAndValidateImplementerReport,
  parseAndValidateIntegratorReport,
  parseAndValidatePlannerReport,
  parseAndValidateReviewerReport
} from '../../shared/fork-heimdall-objective/plan-schema'
import type { Store } from '../persistence'
import { executeObjectiveDispatch } from './dispatch-executor'
import {
  findObjectiveWorkerEvidence,
  requireObjectiveSnapshotBinding,
  type ObjectiveSnapshotBinding
} from './execution-context'
import { validateObjectiveWorkspaceChanges } from './observed-workspace-changes'
import { executeObjectiveLocalAction } from './local-action-executor'
import type { ObjectiveStore } from './objective-store'
import { readObjectiveRoleReport } from './report-ingestion'

type ObjectiveExecutorDependencies = {
  store: Store
  objectiveStore: ObjectiveStore
  snapshotBindings: WeakMap<Snapshot<ObjectiveWorld>, ObjectiveSnapshotBinding>
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

function localActionOutcome(
  action: Exclude<ObjectiveAction, { kind: `dispatch-${string}` }>,
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

async function resolveDispatchOutcome(args: {
  attempt: AttemptEntry
  action: Extract<ObjectiveAction, { kind: `dispatch-${string}` }>
  ledger: WatcherLedger
  binding: ObjectiveSnapshotBinding
  objectiveStore: ObjectiveStore
}): Promise<EffectCertainty> {
  if (!args.attempt.dispatch) {
    return 'not-landed'
  }
  const dispatchId = args.attempt.dispatchId
  if (!dispatchId) {
    return 'indeterminate'
  }
  const evidence = findObjectiveWorkerEvidence(args.ledger, dispatchId)
  if (!evidence) {
    return 'indeterminate'
  }
  if (evidence.outcome === 'failed') {
    return 'not-landed'
  }
  const role =
    args.action.kind === 'dispatch-planner'
      ? 'planner'
      : args.action.kind === 'dispatch-node'
        ? 'implementer'
        : args.action.kind === 'dispatch-reviewer'
          ? 'reviewer'
          : 'integrator'
  const read = await readObjectiveRoleReport({
    target: args.binding.target,
    attemptFingerprint: args.attempt.fingerprint,
    mailboxReportPath: evidence.reportPath,
    role,
    ...(args.action.kind === 'dispatch-node' ? { taskKey: args.action.taskKey } : {})
  })
  if (!read.ok) {
    return 'not-landed'
  }
  if (
    !validateResolvedDispatchReport({
      ...args,
      report: read.report,
      evidenceFiles: evidence.filesModified
    })
  ) {
    return 'not-landed'
  }
  if (args.action.kind === 'dispatch-node' || args.action.kind === 'dispatch-integrator') {
    const observed = await validateObjectiveWorkspaceChanges({
      target: args.binding.target,
      attemptFingerprint: args.attempt.fingerprint,
      reportedFiles: evidence.filesModified,
      writeTerritory: args.binding.contract.writeTerritory
    })
    if (!observed.ok) {
      return 'not-landed'
    }
  }
  return 'landed'
}

export function createObjectiveActionExecutor(
  dependencies: ObjectiveExecutorDependencies
): ActionExecutor<ObjectiveWorld, ObjectiveAction> {
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
      return executeObjectiveLocalAction({
        action: action as Exclude<ObjectiveAction, { kind: `dispatch-${string}` }>,
        binding,
        context,
        objectiveStore: dependencies.objectiveStore
      })
    },
    resolveOutcome(
      attempt: AttemptEntry,
      fresh: LiveSnapshot<ObjectiveWorld>,
      ledger: WatcherLedger
    ): EffectCertainty | Promise<EffectCertainty> {
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
        return 'indeterminate'
      }
      if (!parsed.data.kind.startsWith('dispatch-')) {
        return localActionOutcome(
          parsed.data as Exclude<ObjectiveAction, { kind: `dispatch-${string}` }>,
          binding,
          dependencies.objectiveStore
        )
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
