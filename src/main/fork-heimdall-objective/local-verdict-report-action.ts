import type { ActionOutcome } from '../../shared/fork-heimdall/effect-certainty'
import type { ExecuteContext } from '../../shared/fork-heimdall/kind-contract'
import type { ObjectiveAction } from '../../shared/fork-heimdall-objective/objective-actions'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import {
  parseAndValidateIntegratorReport,
  parseAndValidateReviewerReport,
  type IntegratorReport,
  type ReviewerReport
} from '../../shared/fork-heimdall-objective/plan-schema'
import {
  findObjectiveDispatchAttempt,
  findObjectiveWorkerEvidence,
  type ObjectiveSnapshotBinding
} from './execution-context'
import {
  invalidObjectiveReport,
  rejectedWorkerReport,
  reportActionNaturalKey
} from './local-report-validation'
import { validateObjectiveWorkspaceChanges } from './observed-workspace-changes'
import type { ObjectiveStore } from './objective-store'
import { readObjectiveRoleReport } from './report-ingestion'

type IngestVerdictAction = Extract<ObjectiveAction, { kind: 'ingest-verdict' }>

export async function ingestObjectiveVerdictReport(args: {
  action: IngestVerdictAction
  binding: ObjectiveSnapshotBinding
  context: ExecuteContext<ObjectiveWorld>
  objectiveStore: ObjectiveStore
}): Promise<ActionOutcome> {
  const origin = findObjectiveDispatchAttempt(args.context.ledger, args.action.dispatchId)
  const expectedKind = args.action.role === 'reviewer' ? 'dispatch-reviewer' : 'dispatch-integrator'
  if (
    origin?.action.kind !== expectedKind ||
    origin.action.revisionId !== args.action.revisionId ||
    origin.action.contentIdentity !== args.action.reviewedContentIdentity
  ) {
    return invalidObjectiveReport({
      reason: 'review-dispatch-mismatch',
      code: 'evidence-mismatch',
      role: args.action.role,
      dispatchId: args.action.dispatchId,
      reportPath: args.action.reportPath,
      detail: 'Verdict ingest action does not match its review dispatch'
    })
  }
  const evidence = findObjectiveWorkerEvidence(args.context.ledger, args.action.dispatchId)
  const rejection = rejectedWorkerReport({
    evidence,
    role: args.action.role,
    dispatchId: args.action.dispatchId,
    reportPath: args.action.reportPath
  })
  if (rejection) {
    return rejection
  }
  if (evidence?.outcome !== 'succeeded' || evidence.reportPath !== args.action.reportPath) {
    return invalidObjectiveReport({
      reason: 'review-report-evidence-mismatch',
      code: 'evidence-mismatch',
      role: args.action.role,
      dispatchId: args.action.dispatchId,
      reportPath: args.action.reportPath,
      detail: 'Review report does not match accepted worker completion evidence'
    })
  }
  if (!evidence.filesModifiedValid) {
    return invalidObjectiveReport({
      reason: 'review-report-evidence-malformed',
      code: 'evidence-malformed',
      role: args.action.role,
      dispatchId: args.action.dispatchId,
      reportPath: args.action.reportPath,
      detail: 'Worker completion filesModified must be an array of workspace-relative paths'
    })
  }
  const plan = args.objectiveStore.getPlan(args.action.revisionId)
  if (!plan) {
    return invalidObjectiveReport({
      reason: 'review-plan-missing',
      code: 'semantic-invalid',
      role: args.action.role,
      dispatchId: args.action.dispatchId,
      reportPath: args.action.reportPath,
      detail: `Plan ${args.action.revisionId} is unavailable`
    })
  }
  let report: ReviewerReport | IntegratorReport
  let reportDigest: string
  try {
    if (args.action.role === 'reviewer') {
      const read = await readObjectiveRoleReport({
        target: args.binding.target,
        attemptFingerprint: origin.attempt.fingerprint,
        mailboxReportPath: args.action.reportPath,
        role: 'reviewer'
      })
      if (!read.ok) {
        return invalidObjectiveReport({
          reason: `review-report-${read.reason}`,
          code: read.reason,
          role: 'reviewer',
          dispatchId: args.action.dispatchId,
          reportPath: args.action.reportPath,
          ...(read.detail === undefined ? {} : { detail: read.detail })
        })
      }
      report = parseAndValidateReviewerReport(read.report, plan)
      reportDigest = read.reportDigest
    } else {
      const read = await readObjectiveRoleReport({
        target: args.binding.target,
        attemptFingerprint: origin.attempt.fingerprint,
        mailboxReportPath: args.action.reportPath,
        role: 'integrator'
      })
      if (!read.ok) {
        return invalidObjectiveReport({
          reason: `review-report-${read.reason}`,
          code: read.reason,
          role: 'integrator',
          dispatchId: args.action.dispatchId,
          reportPath: args.action.reportPath,
          ...(read.detail === undefined ? {} : { detail: read.detail }),
          reportedFiles: evidence.filesModified
        })
      }
      report = parseAndValidateIntegratorReport(read.report, plan)
      reportDigest = read.reportDigest
    }
  } catch (error) {
    return invalidObjectiveReport({
      reason: 'review-report-semantic-invalid',
      code: 'semantic-invalid',
      role: args.action.role,
      dispatchId: args.action.dispatchId,
      reportPath: args.action.reportPath,
      detail: error instanceof Error ? error.message : 'Review report semantic validation failed',
      reportedFiles: evidence.filesModified
    })
  }
  if (args.action.role === 'integrator') {
    const observed = await validateObjectiveWorkspaceChanges({
      target: args.binding.target,
      attemptFingerprint: origin.attempt.fingerprint,
      reportedFiles: evidence.filesModified,
      writeTerritory: args.binding.contract.writeTerritory
    })
    if (!observed.ok) {
      const hostVerifiable =
        !observed.reason.startsWith('objective-workspace-route-') &&
        !observed.reason.startsWith('objective-workspace-baseline-') &&
        observed.reason !== 'objective-workspace-observation-failed'
      return invalidObjectiveReport({
        reason: observed.reason,
        code: 'workspace-invalid',
        role: 'integrator',
        dispatchId: args.action.dispatchId,
        reportPath: args.action.reportPath,
        detail: observed.reason,
        reportedFiles: evidence.filesModified,
        observedFiles: observed.observedFiles ?? [],
        hostVerifiable
      })
    }
  }
  await args.context.lease.assertHeld()
  args.objectiveStore.recordVerdict({
    watcherId: args.binding.enrollment.watcherId,
    revisionId: args.action.revisionId,
    dispatchId: args.action.dispatchId,
    role: args.action.role,
    contentIdentity: args.action.reviewedContentIdentity,
    report,
    reportDigest,
    createdAtMs: evidence.atMs
  })
  return {
    effect: 'landed',
    result: {
      kind: 'verdict-ingested',
      naturalKey: reportActionNaturalKey(args.action),
      digest: reportDigest,
      verdict: report.verdict
    }
  }
}
