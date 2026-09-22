import type { ActionOutcome } from '../../shared/fork-heimdall/effect-certainty'
import type { ExecuteContext } from '../../shared/fork-heimdall/kind-contract'
import { getLatestAttempts } from '../../shared/fork-heimdall/ledger-queries'
import type { ObjectiveAction } from '../../shared/fork-heimdall-objective/objective-actions'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import {
  parseAndValidatePlannerReport,
  type PlannerReport
} from '../../shared/fork-heimdall-objective/plan-schema'
import {
  findObjectiveDispatchAttempt,
  findObjectiveWorkerEvidence,
  type ObjectiveSnapshotBinding
} from './execution-context'
import type { ObjectiveStore } from './objective-store'
import {
  invalidObjectiveReport,
  rejectedWorkerReport,
  reportActionNaturalKey
} from './local-report-validation'
import { readObjectiveRoleReport } from './report-ingestion'

type IngestPlanAction = Extract<ObjectiveAction, { kind: 'ingest-plan' }>

function dispatchedTaskKeys(context: ExecuteContext<ObjectiveWorld>): string[] {
  const keys = new Set<string>()
  for (const attempt of getLatestAttempts(context.ledger)) {
    const action = attempt.action as Record<string, unknown>
    if (action.kind === 'dispatch-node' && typeof action.taskKey === 'string') {
      keys.add(action.taskKey)
    }
  }
  return [...keys]
}

export async function ingestObjectivePlanReport(args: {
  action: IngestPlanAction
  binding: ObjectiveSnapshotBinding
  context: ExecuteContext<ObjectiveWorld>
  objectiveStore: ObjectiveStore
}): Promise<ActionOutcome> {
  const origin = findObjectiveDispatchAttempt(args.context.ledger, args.action.dispatchId)
  if (
    origin?.action.kind !== 'dispatch-planner' ||
    origin.action.revisionNumber !== args.action.revisionNumber
  ) {
    return invalidObjectiveReport({
      reason: 'planner-dispatch-mismatch',
      code: 'evidence-mismatch',
      role: 'planner',
      dispatchId: args.action.dispatchId,
      reportPath: args.action.reportPath,
      detail: 'Ingest action does not match its planner dispatch'
    })
  }
  const evidence = findObjectiveWorkerEvidence(args.context.ledger, args.action.dispatchId)
  const rejection = rejectedWorkerReport({
    evidence,
    role: 'planner',
    dispatchId: args.action.dispatchId,
    reportPath: args.action.reportPath
  })
  if (rejection) {
    return rejection
  }
  if (evidence?.outcome !== 'succeeded' || evidence.reportPath !== args.action.reportPath) {
    return invalidObjectiveReport({
      reason: 'planner-report-evidence-mismatch',
      code: 'evidence-mismatch',
      role: 'planner',
      dispatchId: args.action.dispatchId,
      reportPath: args.action.reportPath,
      detail: 'Planner report does not match accepted worker completion evidence'
    })
  }
  if (!evidence.filesModifiedValid) {
    return invalidObjectiveReport({
      reason: 'planner-report-evidence-malformed',
      code: 'evidence-malformed',
      role: 'planner',
      dispatchId: args.action.dispatchId,
      reportPath: args.action.reportPath,
      detail: 'Worker completion filesModified must be an array of workspace-relative paths'
    })
  }
  const read = await readObjectiveRoleReport({
    target: args.binding.target,
    attemptFingerprint: origin.attempt.fingerprint,
    mailboxReportPath: args.action.reportPath,
    role: 'planner'
  })
  if (!read.ok) {
    return invalidObjectiveReport({
      reason: `planner-report-${read.reason}`,
      code: read.reason,
      role: 'planner',
      dispatchId: args.action.dispatchId,
      reportPath: args.action.reportPath,
      ...(read.detail === undefined ? {} : { detail: read.detail })
    })
  }
  let report: PlannerReport
  try {
    report = parseAndValidatePlannerReport(read.report, {
      writeTerritory: args.binding.contract.writeTerritory,
      dispatchedTaskKeys: dispatchedTaskKeys(args.context)
    })
  } catch (error) {
    return invalidObjectiveReport({
      reason: 'planner-report-semantic-invalid',
      code: 'semantic-invalid',
      role: 'planner',
      dispatchId: args.action.dispatchId,
      reportPath: args.action.reportPath,
      detail: error instanceof Error ? error.message : 'Planner report semantic validation failed'
    })
  }
  await args.context.lease.assertHeld()
  const stored = args.objectiveStore.ingestPlan({
    watcherId: args.binding.enrollment.watcherId,
    revisionNumber: args.action.revisionNumber,
    dispatchId: args.action.dispatchId,
    report,
    digest: read.reportDigest,
    createdAtMs: evidence.atMs
  })
  return {
    effect: 'landed',
    result: {
      kind: 'plan-ingested',
      naturalKey: reportActionNaturalKey(args.action),
      digest: read.reportDigest,
      revisionId: stored.revisionId
    }
  }
}
