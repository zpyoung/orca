import type { ActionOutcome } from '../../shared/fork-heimdall/effect-certainty'
import { getLatestAttempts } from '../../shared/fork-heimdall/ledger-queries'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import type { ExecuteContext } from '../../shared/fork-heimdall/kind-contract'
import {
  objectiveActionNaturalKey,
  type ObjectiveAction,
  type ObjectiveActionNaturalKey
} from '../../shared/fork-heimdall-objective/objective-actions'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import {
  parseAndValidateImplementerReport,
  parseAndValidateIntegratorReport,
  parseAndValidatePlannerReport,
  parseAndValidateReviewerReport,
  type ImplementerReport,
  type IntegratorReport,
  type PlannerReport,
  type ReviewerReport
} from '../../shared/fork-heimdall-objective/plan-schema'
import { runCriterionCheck } from './check-runner'
import { computeWorkspaceContentIdentity } from './content-identity'
import {
  findObjectiveDispatchAttempt,
  findObjectiveWorkerEvidence,
  objectiveResultDigest,
  type ObjectiveSnapshotBinding
} from './execution-context'
import { validateObjectiveWorkspaceChanges } from './observed-workspace-changes'
import type { ObjectiveStore } from './objective-store'
import { readObjectiveRoleReport } from './report-ingestion'

type LocalAction = Exclude<ObjectiveAction, { kind: `dispatch-${string}` }>

function invalid(reason: string): ActionOutcome {
  return { effect: 'not-landed', reason }
}

function naturalKey(action: LocalAction): ObjectiveActionNaturalKey {
  const key = objectiveActionNaturalKey(action)
  if (!key) {
    throw new Error(`Objective local action ${action.kind} has no natural key`)
  }
  return key
}

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

async function ingestPlan(args: {
  action: Extract<LocalAction, { kind: 'ingest-plan' }>
  binding: ObjectiveSnapshotBinding
  context: ExecuteContext<ObjectiveWorld>
  objectiveStore: ObjectiveStore
}): Promise<ActionOutcome> {
  const origin = findObjectiveDispatchAttempt(args.context.ledger, args.action.dispatchId)
  if (
    origin?.action.kind !== 'dispatch-planner' ||
    origin.action.revisionNumber !== args.action.revisionNumber
  ) {
    return invalid('planner-dispatch-mismatch')
  }
  const evidence = findObjectiveWorkerEvidence(args.context.ledger, args.action.dispatchId)
  if (evidence?.outcome !== 'succeeded' || evidence.reportPath !== args.action.reportPath) {
    return invalid('planner-report-evidence-mismatch')
  }
  const read = await readObjectiveRoleReport({
    target: args.binding.target,
    attemptFingerprint: origin.attempt.fingerprint,
    mailboxReportPath: args.action.reportPath,
    role: 'planner'
  })
  if (!read.ok) {
    return invalid(`planner-report-${read.reason}`)
  }
  let report: PlannerReport
  try {
    report = parseAndValidatePlannerReport(read.report, {
      writeTerritory: args.binding.contract.writeTerritory,
      dispatchedTaskKeys: dispatchedTaskKeys(args.context)
    })
  } catch (error) {
    return invalid(error instanceof Error ? error.message : 'planner-report-invalid')
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
      naturalKey: naturalKey(args.action),
      digest: read.reportDigest,
      revisionId: stored.revisionId
    }
  }
}

async function ingestImplementerReport(args: {
  action: Extract<LocalAction, { kind: 'ingest-report' }>
  binding: ObjectiveSnapshotBinding
  context: ExecuteContext<ObjectiveWorld>
  objectiveStore: ObjectiveStore
}): Promise<ActionOutcome> {
  const origin = findObjectiveDispatchAttempt(args.context.ledger, args.action.dispatchId)
  if (
    origin?.action.kind !== 'dispatch-node' ||
    origin.action.revisionId !== args.action.revisionId ||
    origin.action.taskKey !== args.action.taskKey ||
    origin.action.contentIdentity !== args.action.dispatchedContentIdentity
  ) {
    return invalid('implementer-dispatch-mismatch')
  }
  if (!args.action.orchestrationTaskId) {
    return invalid('implementer-task-id-missing')
  }
  const evidence = findObjectiveWorkerEvidence(args.context.ledger, args.action.dispatchId)
  if (
    evidence?.outcome !== 'succeeded' ||
    evidence.reportPath !== args.action.reportPath ||
    evidence.orchestrationTaskId !== args.action.orchestrationTaskId
  ) {
    return invalid('implementer-report-evidence-mismatch')
  }
  const task = args.objectiveStore.getTask(args.action.revisionId, args.action.taskKey)
  if (!task) {
    return invalid('implementer-task-missing')
  }
  const read = await readObjectiveRoleReport({
    target: args.binding.target,
    attemptFingerprint: origin.attempt.fingerprint,
    mailboxReportPath: args.action.reportPath,
    role: 'implementer',
    taskKey: args.action.taskKey
  })
  if (!read.ok) {
    return invalid(`implementer-report-${read.reason}`)
  }
  let report: ImplementerReport
  try {
    report = parseAndValidateImplementerReport(
      read.report,
      task,
      args.binding.contract.writeTerritory
    )
  } catch (error) {
    return invalid(error instanceof Error ? error.message : 'implementer-report-invalid')
  }
  const reportedFiles = [...report.filesModified].sort().join('\0')
  if (
    reportedFiles !== [...args.action.filesModified].sort().join('\0') ||
    reportedFiles !== [...evidence.filesModified].sort().join('\0')
  ) {
    return invalid('implementer-files-modified-mismatch')
  }
  const observed = await validateObjectiveWorkspaceChanges({
    target: args.binding.target,
    attemptFingerprint: origin.attempt.fingerprint,
    reportedFiles: report.filesModified,
    writeTerritory: args.binding.contract.writeTerritory
  })
  if (!observed.ok) {
    return invalid(observed.reason)
  }
  await args.context.lease.assertHeld()
  args.objectiveStore.recordNodeDispatch({
    watcherId: args.binding.enrollment.watcherId,
    revisionId: args.action.revisionId,
    taskKey: args.action.taskKey,
    orchestrationTaskId: args.action.orchestrationTaskId,
    dispatchId: args.action.dispatchId,
    dispatchedAtMs: evidence.atMs
  })
  return {
    effect: 'landed',
    result: {
      kind: 'report-ingested',
      naturalKey: naturalKey(args.action),
      digest: read.reportDigest
    }
  }
}

async function runCheck(args: {
  action: Extract<LocalAction, { kind: 'run-check' }>
  binding: ObjectiveSnapshotBinding
  context: ExecuteContext<ObjectiveWorld>
  objectiveStore: ObjectiveStore
}): Promise<ActionOutcome> {
  const criterion = args.objectiveStore.getCriterion(args.action.criterionId)
  if (!criterion || !criterion.shellCheckable || criterion.checkCommand !== args.action.command) {
    return invalid('criterion-check-mismatch')
  }
  await args.context.lease.assertHeld()
  args.objectiveStore.startCheckAttempt({
    watcherId: args.binding.enrollment.watcherId,
    criterionId: criterion.id,
    contentIdentity: args.action.contentIdentity,
    executionHostId: args.binding.target.executionHostId,
    command: args.action.command,
    epoch: args.context.lease.epoch,
    startedAtMs: Date.now()
  })
  const check = await runCriterionCheck({
    command: args.action.command,
    target: args.binding.target
  })
  await args.context.lease.assertHeld()
  args.objectiveStore.completeCheckAttempt({
    criterionId: criterion.id,
    contentIdentity: args.action.contentIdentity,
    exitCode: check.exitCode,
    timedOut: check.timedOut,
    stdoutTail: check.stdoutTail,
    stderrTail: check.stderrTail,
    completedAtMs: check.completedAtMs
  })
  return {
    effect: 'landed',
    result: {
      kind: 'check-recorded',
      naturalKey: naturalKey(args.action),
      digest: objectiveResultDigest(check),
      exitCode: check.exitCode,
      timedOut: check.timedOut
    }
  }
}

async function ingestVerdict(args: {
  action: Extract<LocalAction, { kind: 'ingest-verdict' }>
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
    return invalid('review-dispatch-mismatch')
  }
  const evidence = findObjectiveWorkerEvidence(args.context.ledger, args.action.dispatchId)
  if (evidence?.outcome !== 'succeeded' || evidence.reportPath !== args.action.reportPath) {
    return invalid('review-report-evidence-mismatch')
  }
  const plan = args.objectiveStore.getPlan(args.action.revisionId)
  if (!plan) {
    return invalid('review-plan-missing')
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
        return invalid(`review-report-${read.reason}`)
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
        return invalid(`review-report-${read.reason}`)
      }
      report = parseAndValidateIntegratorReport(read.report, plan)
      reportDigest = read.reportDigest
    }
  } catch (error) {
    return invalid(error instanceof Error ? error.message : 'review-report-invalid')
  }
  if (args.action.role === 'integrator') {
    const observed = await validateObjectiveWorkspaceChanges({
      target: args.binding.target,
      attemptFingerprint: origin.attempt.fingerprint,
      reportedFiles: evidence.filesModified,
      writeTerritory: args.binding.contract.writeTerritory
    })
    if (!observed.ok) {
      return invalid(observed.reason)
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
      naturalKey: naturalKey(args.action),
      digest: reportDigest,
      verdict: report.verdict
    }
  }
}

function landingEvidenceIsCurrent(args: {
  action: Extract<LocalAction, { kind: 'record-landing' }>
  binding: ObjectiveSnapshotBinding
  objectiveStore: ObjectiveStore
}): boolean {
  const projection = args.objectiveStore.project(
    args.binding.enrollment.watcherId,
    undefined,
    args.action.contentIdentity
  )
  const activeRevision = projection.revisions.some(
    (revision) => revision.id === args.action.revisionId && revision.status === 'approved'
  )
  if (!activeRevision) {
    return false
  }
  const nodes = projection.nodes.filter((node) => node.revisionId === args.action.revisionId)
  if (nodes.length === 0 || nodes.some((node) => node.state !== 'succeeded')) {
    return false
  }
  const checksPass = nodes
    .flatMap((node) => node.criteria)
    .filter((criterion) => criterion.shellCheckable)
    .every(
      (criterion) =>
        criterion.lastCheck?.contentIdentity === args.action.contentIdentity &&
        criterion.lastCheck.exitCode === 0 &&
        !criterion.lastCheck.timedOut
    )
  if (!checksPass) {
    return false
  }
  const approved = (role: 'reviewer' | 'integrator'): boolean =>
    projection.verdicts.some(
      (verdict) =>
        verdict.revisionId === args.action.revisionId &&
        verdict.role === role &&
        verdict.verdict === 'approve' &&
        verdict.contentIdentity === args.action.contentIdentity
    )
  return (
    args.binding.contract.tier === 'express' ||
    (approved('reviewer') && (args.binding.contract.tier === 'standard' || approved('integrator')))
  )
}

export async function executeObjectiveLocalAction(args: {
  action: LocalAction
  binding: ObjectiveSnapshotBinding
  context: ExecuteContext<ObjectiveWorld>
  objectiveStore: ObjectiveStore
}): Promise<ActionOutcome> {
  if (args.action.kind === 'ingest-plan') {
    return ingestPlan({ ...args, action: args.action })
  }
  if (args.action.kind === 'activate-plan') {
    await args.context.lease.assertHeld()
    const stored = args.objectiveStore.activatePlan({
      watcherId: args.binding.enrollment.watcherId,
      revisionId: args.action.revisionId,
      digest: args.action.digest,
      approvedAtMs: Date.now()
    })
    return {
      effect: 'landed',
      result: {
        kind: 'plan-activated',
        naturalKey: naturalKey(args.action),
        digest: stored.digest
      }
    }
  }
  if (args.action.kind === 'ingest-report') {
    return ingestImplementerReport({ ...args, action: args.action })
  }
  if (args.action.kind === 'run-check') {
    return runCheck({ ...args, action: args.action })
  }
  if (args.action.kind === 'ingest-verdict') {
    return ingestVerdict({ ...args, action: args.action })
  }
  await args.context.lease.assertHeld()
  if (
    !landingEvidenceIsCurrent({
      action: args.action,
      binding: args.binding,
      objectiveStore: args.objectiveStore
    })
  ) {
    return invalid('landing-evidence-stale')
  }
  const currentIdentity = await computeWorkspaceContentIdentity(args.binding.target)
  if (
    currentIdentity !== args.action.contentIdentity ||
    currentIdentity !== args.context.snapshot.contentIdentity
  ) {
    return invalid('landing-evidence-stale')
  }
  await args.context.lease.assertHeld()
  const stored = args.objectiveStore.recordLanding({
    watcherId: args.binding.enrollment.watcherId,
    rung: args.action.rung,
    contentIdentity: args.action.contentIdentity,
    attemptFingerprint: makeAttemptFingerprint(
      args.action.contentIdentity,
      args.action.kind,
      args.action.evidenceKey
    ),
    payload: { revisionId: args.action.revisionId },
    epoch: args.context.lease.epoch,
    createdAtMs: Date.now()
  })
  return {
    effect: 'landed',
    result: {
      kind: 'landing-recorded',
      naturalKey: naturalKey(args.action),
      digest: objectiveResultDigest(stored)
    }
  }
}
