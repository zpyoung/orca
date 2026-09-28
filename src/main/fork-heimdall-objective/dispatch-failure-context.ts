import type { ExecuteContext } from '../../shared/fork-heimdall/kind-contract'
import {
  latestObjectiveAttempt,
  objectiveAttemptDisposition,
  objectiveAttemptFailureClass,
  objectiveAttempts,
  projectObjectiveReports,
  type ObjectiveAttempt
} from '../../shared/fork-heimdall-objective/decision-context'
import type {
  ObjectivePendingReport,
  ObjectiveWorld
} from '../../shared/fork-heimdall-objective/detail-types'
import type { ObjectiveAction } from '../../shared/fork-heimdall-objective/objective-actions'
import type { ObjectiveSnapshotBinding } from './execution-context'
import type { ObjectiveStore } from './objective-store'
import { readObjectiveRoleReport } from './report-ingestion'
import type { ObjectiveFailureContext } from './role-prompts'

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

type NodeFailureContext = Pick<
  ObjectiveFailureContext,
  'taskKey' | 'failureClass' | 'narrative' | 'failingCriteria'
>

async function deriveNodeFailureContext(args: {
  binding: ObjectiveSnapshotBinding
  ledger: ExecuteContext<ObjectiveWorld>['ledger']
  objectiveStore: ObjectiveStore
  activeRevisionId: string | undefined
}): Promise<NodeFailureContext | undefined> {
  if (args.activeRevisionId === undefined) {
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

/**
 * The most recently rejected repair patch's rejection text for the active revision, or `undefined`
 * when none exists or its rejection was a plan-review `revise` (that case already carries its own
 * findings via `objectivePlannerReviewFindings`, so restating it here would be redundant).
 */
function latestRejectedRepairPatchRejection(args: {
  objectiveStore: ObjectiveStore
  binding: ObjectiveSnapshotBinding
  activeRevisionId: string
}): string | undefined {
  try {
    const latest = args.objectiveStore
      .listPlanPatches(args.binding.enrollment.watcherId)
      .filter((patch) => patch.revisionId === args.activeRevisionId && patch.status === 'rejected')
      .sort((left, right) => right.repairOrdinal - left.repairOrdinal)[0]
    if (!latest || latest.rejection === null || latest.rejection === 'plan-review-revise') {
      return undefined
    }
    return latest.rejection
  } catch {
    return undefined
  }
}

/**
 * The first declared gate (if any) with a completed, failing attempt at the dispatch's content
 * identity. A `run-gate` attempt that never completed but settled `not-landed` has no completed row
 * to read, so it falls back to the ledger's latest such attempt for that gate — the planner still
 * needs a gate name and command to react to, even with no exit code or output to show.
 */
function deriveGateFailureContext(args: {
  binding: ObjectiveSnapshotBinding
  objectiveStore: ObjectiveStore
  ledger: ExecuteContext<ObjectiveWorld>['ledger']
  contentIdentity: string
}): ObjectiveFailureContext['gateFailure'] | undefined {
  try {
    const gates = args.binding.contract.gates
    if (!gates || gates.length === 0) {
      return undefined
    }
    const watcherId = args.binding.enrollment.watcherId
    const attempts = objectiveAttempts(args.ledger)
    for (const gate of gates) {
      const attempt = args.objectiveStore.getGateAttempt(watcherId, gate.name, args.contentIdentity)
      if (
        attempt &&
        attempt.completedAtMs !== null &&
        (attempt.exitCode !== 0 || attempt.timedOut === true)
      ) {
        return {
          gateName: attempt.gateName,
          command: attempt.command,
          exitCode: attempt.exitCode,
          timedOut: attempt.timedOut,
          stdoutTail: attempt.stdoutTail,
          stderrTail: attempt.stderrTail
        }
      }
      const notLanded = latestObjectiveAttempt(
        attempts,
        (action) =>
          action.kind === 'run-gate' &&
          action.gateName === gate.name &&
          action.contentIdentity === args.contentIdentity
      )
      if (
        notLanded &&
        notLanded.action.kind === 'run-gate' &&
        objectiveAttemptDisposition(notLanded.attempt, args.ledger) === 'not-landed'
      ) {
        return {
          gateName: notLanded.action.gateName,
          command: notLanded.action.command,
          exitCode: null,
          timedOut: false,
          stdoutTail: null,
          stderrTail: null,
          detail: 'the gate attempt itself failed to land'
        }
      }
    }
    return undefined
  } catch {
    return undefined
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
  if (args.action.reason !== 'replan-after-failure') {
    return undefined
  }
  const nodeFailure = await deriveNodeFailureContext(args)
  const gateFailure = deriveGateFailureContext({
    binding: args.binding,
    objectiveStore: args.objectiveStore,
    ledger: args.ledger,
    contentIdentity: args.action.contentIdentity
  })
  const previousRepairRejection =
    args.activeRevisionId === undefined
      ? undefined
      : latestRejectedRepairPatchRejection({
          objectiveStore: args.objectiveStore,
          binding: args.binding,
          activeRevisionId: args.activeRevisionId
        })
  if (
    nodeFailure === undefined &&
    gateFailure === undefined &&
    previousRepairRejection === undefined
  ) {
    return undefined
  }
  return {
    ...nodeFailure,
    ...(gateFailure === undefined ? {} : { gateFailure }),
    ...(previousRepairRejection === undefined ? {} : { previousRepairRejection })
  }
}
