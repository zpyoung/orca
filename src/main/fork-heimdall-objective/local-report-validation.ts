import {
  createReportValidationProvenance,
  type ActionOutcome,
  type ReportValidationCode,
  type ReportValidationProvenance
} from '../../shared/fork-heimdall/effect-certainty'
import {
  objectiveActionNaturalKey,
  type ObjectiveAction,
  type ObjectiveActionNaturalKey
} from '../../shared/fork-heimdall-objective/objective-actions'
import type { ObjectiveWorkerEvidence } from './execution-context'

export function reportActionNaturalKey(
  action: Extract<ObjectiveAction, { kind: 'ingest-plan' | 'ingest-report' | 'ingest-verdict' }>
): ObjectiveActionNaturalKey {
  const key = objectiveActionNaturalKey(action)
  if (!key) {
    throw new Error(`Objective report action ${action.kind} has no natural key`)
  }
  return key
}

export function invalidObjectiveReport(args: {
  reason: string
  code: ReportValidationCode
  sourceCode?: string
  role: ReportValidationProvenance['role']
  dispatchId: string
  taskKey?: string
  reportPath: string | null
  detail?: string
  reportDigest?: string
  reportedFiles?: readonly string[]
  observedFiles?: readonly string[]
  hostVerifiable?: boolean
}): ActionOutcome {
  const reportValidation = createReportValidationProvenance({
    status: args.hostVerifiable === false ? 'unverifiable' : 'rejected',
    code: args.code,
    ...(args.sourceCode === undefined ? {} : { sourceCode: args.sourceCode }),
    role: args.role,
    dispatchId: args.dispatchId,
    ...(args.taskKey === undefined ? {} : { taskKey: args.taskKey }),
    reportPath: args.reportPath,
    ...(args.detail === undefined ? {} : { detail: args.detail }),
    ...(args.reportedFiles === undefined ? {} : { reportedFiles: args.reportedFiles }),
    ...(args.observedFiles === undefined ? {} : { observedFiles: args.observedFiles }),
    hostVerifiable: args.hostVerifiable !== false
  })
  return {
    effect: 'not-landed',
    reason: args.reason,
    result: {
      ...(reportValidation.detail === undefined ? {} : { detail: reportValidation.detail }),
      reportedFiles: reportValidation.reportedFiles,
      ...(args.reportDigest === undefined ? {} : { reportDigest: args.reportDigest }),
      observedFiles: reportValidation.observedFiles,
      reportValidation
    }
  }
}

export function rejectedWorkerReport(args: {
  evidence: ObjectiveWorkerEvidence | null
  role: ReportValidationProvenance['role']
  dispatchId: string
  taskKey?: string
  reportPath: string | null
}): ActionOutcome | null {
  if (args.evidence === null) {
    return null
  }
  if (!args.evidence.reportRejectionValid) {
    return invalidObjectiveReport({
      reason: `${args.role}-report-rejection-evidence-malformed`,
      code: 'evidence-malformed',
      role: args.role,
      dispatchId: args.dispatchId,
      ...(args.taskKey === undefined ? {} : { taskKey: args.taskKey }),
      reportPath: args.reportPath,
      detail: 'Worker completion carried malformed report-rejection evidence'
    })
  }
  if (args.evidence.reportRejection === null) {
    return null
  }
  return invalidObjectiveReport({
    reason: `${args.role}-report-rejected`,
    code: 'semantic-invalid',
    sourceCode: args.evidence.reportRejection.code,
    role: args.role,
    dispatchId: args.dispatchId,
    ...(args.taskKey === undefined ? {} : { taskKey: args.taskKey }),
    reportPath: args.reportPath,
    detail: args.evidence.reportRejection.reason,
    reportedFiles: args.evidence.filesModified
  })
}

export type WorkerReportEvidenceVerification =
  | { ok: true; evidence: ObjectiveWorkerEvidence }
  | { ok: false; outcome: ActionOutcome }

/**
 * Runs the rejection / evidence-mismatch / filesModifiedValid gate every ingest-report action
 * applies before trusting a worker's accepted completion evidence. `reasonPrefix` and `detailPrefix`
 * are passed explicitly rather than derived from `role`, since role and reason-prefix diverge for
 * the plan-review and verdict actions.
 */
export function verifyWorkerReportEvidence(args: {
  evidence: ObjectiveWorkerEvidence | null
  role: ReportValidationProvenance['role']
  reasonPrefix: string
  detailPrefix: string
  dispatchId: string
  taskKey?: string
  reportPath: string | null
  orchestrationTaskId?: string
}): WorkerReportEvidenceVerification {
  const rejection = rejectedWorkerReport({
    evidence: args.evidence,
    role: args.role,
    dispatchId: args.dispatchId,
    ...(args.taskKey === undefined ? {} : { taskKey: args.taskKey }),
    reportPath: args.reportPath
  })
  if (rejection) {
    return { ok: false, outcome: rejection }
  }
  if (
    args.evidence?.outcome !== 'succeeded' ||
    args.evidence.reportPath !== args.reportPath ||
    (args.orchestrationTaskId !== undefined &&
      args.evidence.orchestrationTaskId !== args.orchestrationTaskId)
  ) {
    return {
      ok: false,
      outcome: invalidObjectiveReport({
        reason: `${args.reasonPrefix}-report-evidence-mismatch`,
        code: 'evidence-mismatch',
        role: args.role,
        dispatchId: args.dispatchId,
        ...(args.taskKey === undefined ? {} : { taskKey: args.taskKey }),
        reportPath: args.reportPath,
        detail: `${args.detailPrefix} report does not match accepted worker completion evidence`
      })
    }
  }
  if (!args.evidence.filesModifiedValid) {
    return {
      ok: false,
      outcome: invalidObjectiveReport({
        reason: `${args.reasonPrefix}-report-evidence-malformed`,
        code: 'evidence-malformed',
        role: args.role,
        dispatchId: args.dispatchId,
        ...(args.taskKey === undefined ? {} : { taskKey: args.taskKey }),
        reportPath: args.reportPath,
        detail: 'Worker completion filesModified must be an array of workspace-relative paths'
      })
    }
  }
  return { ok: true, evidence: args.evidence }
}
