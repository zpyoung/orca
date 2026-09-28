import type { ActionOutcome } from '../../shared/fork-heimdall/effect-certainty'
import type { ExecuteContext } from '../../shared/fork-heimdall/kind-contract'
import { getLatestAttempts } from '../../shared/fork-heimdall/ledger-queries'
import type { ObjectiveAction } from '../../shared/fork-heimdall-objective/objective-actions'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import { objectiveFrozenTaskKeys } from '../../shared/fork-heimdall-objective/objective-repair-state'
import {
  PlannerRepairReportSchema,
  parseAndValidatePlannerRepairReport,
  type PlannerRepairReport
} from '../../shared/fork-heimdall-objective/plan-repair-schema'
import {
  OBJECTIVE_PLAN_ASSUMPTIONS_MAX_ENTRIES,
  parseAndValidatePlannerReport,
  type PlannerReport
} from '../../shared/fork-heimdall-objective/plan-schema'
import {
  findObjectiveDispatchAttempt,
  findObjectiveWorkerEvidence,
  type ObjectiveSnapshotBinding
} from './execution-context'
import type { ObjectivePlanPatchRecord, ObjectiveStore } from './objective-store'
import {
  invalidObjectiveReport,
  reportActionNaturalKey,
  verifyWorkerReportEvidence
} from './local-report-validation'
import { readObjectiveRoleReport } from './report-ingestion'

type IngestPlanAction = Extract<ObjectiveAction, { kind: 'ingest-plan' }>

const PLAN_PATCH_REJECTION_MAX_LENGTH = 2_000

function dispatchedTaskKeys(context: ExecuteContext<ObjectiveWorld>): string[] {
  const keys = new Set<string>()
  for (const attempt of getLatestAttempts(context.ledger)) {
    const action = attempt.action
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
    origin.action.revisionNumber !== args.action.revisionNumber ||
    (args.action.plannerMode === 'repair' && origin.action.repairOrdinal === undefined)
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
  const originIsRepair = origin.action.plannerMode === 'repair'
  const actionIsRepair = args.action.plannerMode === 'repair'
  if (
    originIsRepair !== actionIsRepair ||
    (actionIsRepair &&
      args.action.targetRevisionId !== undefined &&
      origin.action.repairRevisionId !== args.action.targetRevisionId)
  ) {
    return invalidObjectiveReport({
      reason: 'planner-repair-origin-mismatch',
      code: 'evidence-mismatch',
      role: 'planner',
      dispatchId: args.action.dispatchId,
      reportPath: args.action.reportPath,
      detail: 'Repair ingest action does not match its originating dispatch-planner shape'
    })
  }
  const verification = verifyWorkerReportEvidence({
    evidence: findObjectiveWorkerEvidence(args.context.ledger, args.action.dispatchId),
    role: 'planner',
    reasonPrefix: 'planner',
    detailPrefix: 'Planner',
    dispatchId: args.action.dispatchId,
    reportPath: args.action.reportPath
  })
  if (!verification.ok) {
    return verification.outcome
  }
  const evidence = verification.evidence
  const read = await readObjectiveRoleReport({
    target: args.binding.target,
    attemptFingerprint: origin.attempt.fingerprint,
    mailboxReportPath: args.action.reportPath,
    role: 'planner',
    ...(args.action.plannerMode === 'repair' ? { plannerMode: 'repair' } : {})
  })
  if (!read.ok) {
    // a repair report that reads as JSON but fails schema/role validation still reaches
    // ingestObjectivePlanRepair, so it lands as a stored rejected patch that counts toward the
    // episode's retry budget (X1) instead of vanishing as a bare not-landed ingest
    if (args.action.plannerMode === 'repair' && read.rawInput !== undefined) {
      return ingestObjectivePlanRepair({
        action: args.action,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatch-planner schema's superRefine requires repairOrdinal whenever shape is 'repair', which this branch (actionIsRepair === originIsRepair) already established.
        repairOrdinal: origin.action.repairOrdinal as number,
        rawReport: read.rawInput,
        evidenceAtMs: evidence.atMs,
        binding: args.binding,
        context: args.context,
        objectiveStore: args.objectiveStore
      })
    }
    return invalidObjectiveReport({
      reason: `planner-report-${read.reason}`,
      code: read.reason,
      role: 'planner',
      dispatchId: args.action.dispatchId,
      reportPath: args.action.reportPath,
      ...(read.detail === undefined ? {} : { detail: read.detail })
    })
  }
  if (args.action.plannerMode === 'repair') {
    return ingestObjectivePlanRepair({
      action: args.action,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatch-planner schema's superRefine requires repairOrdinal whenever shape is 'repair', which this branch (actionIsRepair === originIsRepair) already established.
      repairOrdinal: origin.action.repairOrdinal as number,
      rawReport: read.report,
      evidenceAtMs: evidence.atMs,
      binding: args.binding,
      context: args.context,
      objectiveStore: args.objectiveStore
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

function firstFrozenTouchedTaskKey(
  report: PlannerRepairReport,
  frozen: ReadonlySet<string>
): string | null {
  for (const task of report.repair.upsertTasks) {
    if (frozen.has(task.taskKey)) {
      return task.taskKey
    }
  }
  for (const taskKey of report.repair.dropTaskKeys) {
    if (frozen.has(taskKey)) {
      return taskKey
    }
  }
  return null
}

/**
 * Best-effort early check: the target revision's assumptions count as seen here can go stale before
 * the patch is actually applied (another patch may land first), so `applyPlanPatch` still owns the
 * authoritative, transactional check — this only lets a planner learn of an over-limit repair without
 * waiting for the apply step to reject it.
 */
function assumptionsLimitRejection(
  objectiveStore: ObjectiveStore,
  targetRevisionId: string,
  report: PlannerRepairReport
): string | null {
  const currentAssumptionsCount =
    objectiveStore.getPlanReport(targetRevisionId)?.assumptions?.length ?? 0
  const mergedCount = currentAssumptionsCount + (report.assumptions?.length ?? 0)
  return mergedCount > OBJECTIVE_PLAN_ASSUMPTIONS_MAX_ENTRIES
    ? `merged ${mergedCount} exceeds the ${OBJECTIVE_PLAN_ASSUMPTIONS_MAX_ENTRIES}-assumption limit`
    : null
}

function repairPatchOutcome(
  action: IngestPlanAction,
  stored: ObjectivePlanPatchRecord
): ActionOutcome {
  return {
    effect: 'landed',
    result: {
      kind: 'plan-patch-ingested',
      naturalKey: reportActionNaturalKey(action),
      patchId: stored.id,
      status: stored.status,
      ...(stored.rejection === null ? {} : { rejection: stored.rejection })
    }
  }
}

/**
 * Ingests a planner repair proposal as a plan patch, always landing: a validation failure or a
 * frozen-node conflict is stored as a rejected patch rather than discarded, so a repeated planner
 * mistake shows up as a retry rather than a silent no-op.
 */
async function ingestObjectivePlanRepair(args: {
  action: IngestPlanAction
  repairOrdinal: number
  rawReport: unknown
  evidenceAtMs: number
  binding: ObjectiveSnapshotBinding
  context: ExecuteContext<ObjectiveWorld>
  objectiveStore: ObjectiveStore
}): Promise<ActionOutcome> {
  const targetRevisionId = args.action.targetRevisionId
  if (targetRevisionId === undefined) {
    return invalidObjectiveReport({
      reason: 'planner-repair-target-revision-missing',
      code: 'semantic-invalid',
      role: 'planner',
      dispatchId: args.action.dispatchId,
      reportPath: args.action.reportPath,
      detail: 'Repair ingestion requires targetRevisionId'
    })
  }
  const currentPlan = args.objectiveStore.getPlan(targetRevisionId)
  if (!currentPlan) {
    return invalidObjectiveReport({
      reason: 'planner-repair-target-revision-missing',
      code: 'semantic-invalid',
      role: 'planner',
      dispatchId: args.action.dispatchId,
      reportPath: args.action.reportPath,
      detail: `Target revision ${targetRevisionId} was not found`
    })
  }
  const watcherId = args.binding.enrollment.watcherId

  let report: PlannerRepairReport
  try {
    report = parseAndValidatePlannerRepairReport(
      args.rawReport,
      { writeTerritory: args.binding.contract.writeTerritory },
      currentPlan
    )
  } catch (error) {
    const message = (
      error instanceof Error ? error.message : 'Planner repair report validation failed'
    ).slice(0, PLAN_PATCH_REJECTION_MAX_LENGTH)
    const rawRepairReport = PlannerRepairReportSchema.safeParse(args.rawReport)
    await args.context.lease.assertHeld()
    const stored = args.objectiveStore.ingestPlanPatch({
      watcherId,
      revisionId: targetRevisionId,
      dispatchId: args.action.dispatchId,
      repairOrdinal: args.repairOrdinal,
      report: rawRepairReport.success
        ? rawRepairReport.data
        : { repair: { upsertTasks: [], dropTaskKeys: [] } },
      createdAtMs: args.evidenceAtMs,
      rejection: `invalid-report:${message}`
    })
    return repairPatchOutcome(args.action, stored)
  }

  const frozen = objectiveFrozenTaskKeys(
    args.context.snapshot.world,
    args.context.ledger,
    targetRevisionId
  )
  const frozenTaskKey = firstFrozenTouchedTaskKey(report, frozen)
  const rejection =
    frozenTaskKey !== null
      ? `changes-frozen-node:${frozenTaskKey}`
      : assumptionsLimitRejection(args.objectiveStore, targetRevisionId, report)
  await args.context.lease.assertHeld()
  const stored = args.objectiveStore.ingestPlanPatch({
    watcherId,
    revisionId: targetRevisionId,
    dispatchId: args.action.dispatchId,
    repairOrdinal: args.repairOrdinal,
    report,
    createdAtMs: args.evidenceAtMs,
    ...(rejection === null ? {} : { rejection })
  })
  return repairPatchOutcome(args.action, stored)
}
