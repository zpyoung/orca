import type { ExecuteContext } from '../../shared/fork-heimdall/kind-contract'
import {
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
