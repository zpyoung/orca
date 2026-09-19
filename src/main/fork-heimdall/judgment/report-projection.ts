import {
  objectiveAttempts,
  projectObjectiveReports
} from '../../../shared/fork-heimdall-objective/decision-context'
import type {
  JudgmentReportEvidence,
  ObjectiveNodeProjection,
  ObjectiveWorld
} from '../../../shared/fork-heimdall-objective/detail-types'
import {
  parseAndValidateImplementerReport,
  parseAndValidateIntegratorReport,
  parseAndValidateReviewerReport,
  type ObjectivePlan,
  type ObjectivePlanTask
} from '../../../shared/fork-heimdall-objective/plan-schema'
import type { WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import type { WatcherEnrollment } from '../../../shared/fork-heimdall/watcher-types'
import type { ObjectiveWorkspaceTarget } from '../../fork-heimdall-objective/content-identity'
import { readObjectiveRoleReport } from '../../fork-heimdall-objective/report-ingestion'

type ReportCandidate =
  | {
      dispatchId: string
      role: 'implementer'
      node: ObjectiveNodeProjection
    }
  | {
      dispatchId: string
      role: 'reviewer' | 'integrator'
    }

function validationTask(node: ObjectiveNodeProjection): ObjectivePlanTask {
  return {
    taskKey: node.taskKey,
    title: 'Current objective task',
    spec: 'Current objective task validation projection.',
    deps: node.deps,
    criteria: node.criteria,
    declaresDependencyChange: false
  }
}

/**
 * Reads only reports that can affect quality judgment for the active plan. The mailbox path remains
 * untrusted: readObjectiveRoleReport derives the authoritative path from the dispatch fingerprint
 * and applies the authority-root, file-identity, byte-limit, binary, and strict-schema checks.
 */
export async function readObjectiveJudgmentReports(args: {
  world: ObjectiveWorld
  ledger: WatcherLedger
  target: ObjectiveWorkspaceTarget
  enrollment: WatcherEnrollment
}): Promise<JudgmentReportEvidence[]> {
  if (
    args.ledger.watcherId !== args.enrollment.watcherId ||
    args.target.executionHostId !== args.enrollment.executionHostId ||
    args.target.workspacePath !== args.enrollment.workspacePath ||
    args.target.kind !== args.world.workspaceKind
  ) {
    return []
  }

  const activeRevision = args.world.plan.revisions
    .filter((revision) => revision.status === 'approved')
    .sort((left, right) => right.number - left.number)[0]
  if (!activeRevision) {
    return []
  }

  const activeNodes = args.world.plan.nodes.filter((node) => node.revisionId === activeRevision.id)
  const validationPlan: ObjectivePlan = activeNodes.map(validationTask)
  const attempts = objectiveAttempts(args.ledger)
  const attemptsByDispatchId = new Map(
    attempts.flatMap(({ action, attempt }) =>
      attempt.dispatchId === undefined ? [] : ([[attempt.dispatchId, { action, attempt }]] as const)
    )
  )
  const reportsByDispatchId = new Map(
    projectObjectiveReports(args.ledger)
      .filter((report) => report.outcome === 'succeeded')
      .map((report) => [report.dispatchId, report] as const)
  )

  const candidates = new Map<string, ReportCandidate>()
  for (const node of activeNodes) {
    if (!node.dispatchId) {
      continue
    }
    const origin = attemptsByDispatchId.get(node.dispatchId)
    const report = reportsByDispatchId.get(node.dispatchId)
    if (
      origin?.action.kind !== 'dispatch-node' ||
      origin.action.revisionId !== activeRevision.id ||
      origin.action.taskKey !== node.taskKey ||
      report?.actionKind !== 'dispatch-node' ||
      report.taskKey !== node.taskKey ||
      report.orchestrationTaskId !== node.orchestrationTaskId
    ) {
      continue
    }
    candidates.set(node.dispatchId, {
      dispatchId: node.dispatchId,
      role: 'implementer',
      node
    })
  }

  const latestReviewCandidates = new Map<'reviewer' | 'integrator', ReportCandidate>()
  for (const { action, attempt } of attempts) {
    if (
      !attempt.dispatchId ||
      !('revisionId' in action) ||
      action.revisionId !== activeRevision.id
    ) {
      continue
    }
    if (action.kind === 'dispatch-reviewer') {
      latestReviewCandidates.set('reviewer', {
        dispatchId: attempt.dispatchId,
        role: 'reviewer'
      })
    } else if (action.kind === 'dispatch-integrator') {
      latestReviewCandidates.set('integrator', {
        dispatchId: attempt.dispatchId,
        role: 'integrator'
      })
    }
  }
  for (const candidate of latestReviewCandidates.values()) {
    const report = reportsByDispatchId.get(candidate.dispatchId)
    if (report?.actionKind === `dispatch-${candidate.role}`) {
      candidates.set(candidate.dispatchId, candidate)
    }
  }

  const evidence: JudgmentReportEvidence[] = []
  for (const candidate of [...candidates.values()].sort((left, right) =>
    left.dispatchId < right.dispatchId ? -1 : left.dispatchId > right.dispatchId ? 1 : 0
  )) {
    const origin = attemptsByDispatchId.get(candidate.dispatchId)
    const projectedReport = reportsByDispatchId.get(candidate.dispatchId)
    if (!origin || !projectedReport) {
      continue
    }

    try {
      if (candidate.role === 'implementer') {
        const read = await readObjectiveRoleReport({
          target: args.target,
          attemptFingerprint: origin.attempt.fingerprint,
          mailboxReportPath: projectedReport.reportPath,
          role: 'implementer',
          taskKey: candidate.node.taskKey
        })
        if (!read.ok) {
          continue
        }
        const report = parseAndValidateImplementerReport(
          read.report,
          validationTask(candidate.node),
          args.world.contract.writeTerritory
        )
        if (
          [...report.filesModified].sort().join('\0') !==
          [...projectedReport.filesModified].sort().join('\0')
        ) {
          continue
        }
        evidence.push({
          dispatchId: candidate.dispatchId,
          role: candidate.role,
          digest: read.reportDigest,
          payload: { ...report }
        })
        continue
      }

      if (candidate.role === 'reviewer') {
        const read = await readObjectiveRoleReport({
          target: args.target,
          attemptFingerprint: origin.attempt.fingerprint,
          mailboxReportPath: projectedReport.reportPath,
          role: 'reviewer'
        })
        if (!read.ok) {
          continue
        }
        const report = parseAndValidateReviewerReport(read.report, validationPlan)
        evidence.push({
          dispatchId: candidate.dispatchId,
          role: candidate.role,
          digest: read.reportDigest,
          payload: { ...report }
        })
        continue
      }

      const read = await readObjectiveRoleReport({
        target: args.target,
        attemptFingerprint: origin.attempt.fingerprint,
        mailboxReportPath: projectedReport.reportPath,
        role: 'integrator'
      })
      if (!read.ok) {
        continue
      }
      const report = parseAndValidateIntegratorReport(read.report, validationPlan)
      evidence.push({
        dispatchId: candidate.dispatchId,
        role: candidate.role,
        digest: read.reportDigest,
        payload: { ...report }
      })
    } catch {
      // Evidence is optional and non-authoritative. An unavailable or invalid report contributes none.
    }
  }
  return evidence
}
