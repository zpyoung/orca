import type { ActionOutcome } from '../../shared/fork-heimdall/effect-certainty'
import type { ExecuteContext } from '../../shared/fork-heimdall/kind-contract'
import {
  objectiveActionNaturalKey,
  type ObjectiveAction,
  type ObjectiveActionNaturalKey
} from '../../shared/fork-heimdall-objective/objective-actions'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import {
  parseAndValidatePlanReviewReport,
  type PlanReviewReport
} from '../../shared/fork-heimdall-objective/plan-review-schema'
import type { ObjectivePlanAssumption } from '../../shared/fork-heimdall-objective/plan-schema'
import {
  findObjectiveDispatchAttempt,
  findObjectiveWorkerEvidence,
  type ObjectiveSnapshotBinding
} from './execution-context'
import { invalidObjectiveReport, rejectedWorkerReport } from './local-report-validation'
import type { ObjectiveStore } from './objective-store'
import { readObjectiveRoleReport } from './report-ingestion'

type IngestPlanReviewAction = Extract<ObjectiveAction, { kind: 'ingest-plan-review' }>
type PlanReviewTarget = IngestPlanReviewAction['target']

function naturalKey(action: IngestPlanReviewAction): ObjectiveActionNaturalKey {
  const key = objectiveActionNaturalKey(action)
  if (!key) {
    throw new Error('Objective plan-review ingest action has no natural key')
  }
  return key
}

function targetId(target: PlanReviewTarget): string {
  return target.kind === 'revision' ? target.revisionId : target.patchId
}

/**
 * The declared assumptions a plan review must assess: the draft revision's, or a pending patch's
 * own. `undefined` means the target itself is unavailable, distinct from a target with none declared.
 */
function targetAssumptions(
  objectiveStore: ObjectiveStore,
  target: PlanReviewTarget
): readonly ObjectivePlanAssumption[] | undefined {
  const found =
    target.kind === 'revision'
      ? objectiveStore.getPlanReport(target.revisionId)
      : objectiveStore.getPlanPatch(target.patchId)?.report
  return found === null || found === undefined ? undefined : (found.assumptions ?? [])
}

/**
 * Persists a plan critic's verdict on a draft revision or a pending patch, mirroring
 * `ingestObjectiveVerdictReport`. A `revise` verdict on the first review round also rejects the
 * target outright, freeing it for a fresh planner dispatch; round two and any `escalate` leave the
 * target as is for the owner-escalation path to handle.
 */
export async function ingestObjectivePlanReviewReport(args: {
  action: IngestPlanReviewAction
  binding: ObjectiveSnapshotBinding
  context: ExecuteContext<ObjectiveWorld>
  objectiveStore: ObjectiveStore
}): Promise<ActionOutcome> {
  const { action } = args
  const origin = findObjectiveDispatchAttempt(args.context.ledger, action.dispatchId)
  if (
    origin?.action.kind !== 'dispatch-plan-review' ||
    origin.action.target.kind !== action.target.kind ||
    targetId(origin.action.target) !== targetId(action.target)
  ) {
    return invalidObjectiveReport({
      reason: 'plan-review-dispatch-mismatch',
      code: 'evidence-mismatch',
      role: 'reviewer',
      dispatchId: action.dispatchId,
      reportPath: action.reportPath,
      detail: 'Plan review ingest action does not match its review dispatch'
    })
  }
  const evidence = findObjectiveWorkerEvidence(args.context.ledger, action.dispatchId)
  const rejection = rejectedWorkerReport({
    evidence,
    role: 'reviewer',
    dispatchId: action.dispatchId,
    reportPath: action.reportPath
  })
  if (rejection) {
    return rejection
  }
  if (evidence?.outcome !== 'succeeded' || evidence.reportPath !== action.reportPath) {
    return invalidObjectiveReport({
      reason: 'plan-review-report-evidence-mismatch',
      code: 'evidence-mismatch',
      role: 'reviewer',
      dispatchId: action.dispatchId,
      reportPath: action.reportPath,
      detail: 'Plan review report does not match accepted worker completion evidence'
    })
  }
  if (!evidence.filesModifiedValid) {
    return invalidObjectiveReport({
      reason: 'plan-review-report-evidence-malformed',
      code: 'evidence-malformed',
      role: 'reviewer',
      dispatchId: action.dispatchId,
      reportPath: action.reportPath,
      detail: 'Worker completion filesModified must be an array of workspace-relative paths'
    })
  }
  const assumptions = targetAssumptions(args.objectiveStore, action.target)
  if (assumptions === undefined) {
    return invalidObjectiveReport({
      reason: 'plan-review-target-missing',
      code: 'semantic-invalid',
      role: 'reviewer',
      dispatchId: action.dispatchId,
      reportPath: action.reportPath,
      detail: `Plan review target ${action.target.kind} ${targetId(action.target)} is unavailable`
    })
  }

  let report: PlanReviewReport
  let reportDigest: string
  try {
    const read = await readObjectiveRoleReport({
      target: args.binding.target,
      attemptFingerprint: origin.attempt.fingerprint,
      mailboxReportPath: action.reportPath,
      role: 'plan-review'
    })
    if (!read.ok) {
      return invalidObjectiveReport({
        reason: `plan-review-report-${read.reason}`,
        code: read.reason,
        role: 'reviewer',
        dispatchId: action.dispatchId,
        reportPath: action.reportPath,
        ...(read.detail === undefined ? {} : { detail: read.detail })
      })
    }
    report = parseAndValidatePlanReviewReport(read.report, assumptions.length, assumptions)
    reportDigest = read.reportDigest
  } catch (error) {
    return invalidObjectiveReport({
      reason: 'plan-review-report-semantic-invalid',
      code: 'semantic-invalid',
      role: 'reviewer',
      dispatchId: action.dispatchId,
      reportPath: action.reportPath,
      detail:
        error instanceof Error ? error.message : 'Plan review report semantic validation failed',
      reportedFiles: evidence.filesModified
    })
  }

  await args.context.lease.assertHeld()
  args.objectiveStore.recordPlanReview({
    watcherId: args.binding.enrollment.watcherId,
    targetKind: action.target.kind,
    targetId: targetId(action.target),
    round: origin.action.round,
    dispatchId: action.dispatchId,
    report,
    reportDigest,
    createdAtMs: evidence.atMs
  })
  if (report.verdict === 'revise' && origin.action.round === 1) {
    if (action.target.kind === 'revision') {
      args.objectiveStore.rejectDraftRevision({
        watcherId: args.binding.enrollment.watcherId,
        revisionId: action.target.revisionId
      })
    } else {
      args.objectiveStore.rejectPlanPatch({
        patchId: action.target.patchId,
        rejection: 'plan-review-revise',
        resolvedAtMs: Date.now()
      })
    }
  }
  return {
    effect: 'landed',
    result: {
      kind: 'plan-review-ingested',
      naturalKey: naturalKey(action),
      verdict: report.verdict,
      digest: reportDigest
    }
  }
}
