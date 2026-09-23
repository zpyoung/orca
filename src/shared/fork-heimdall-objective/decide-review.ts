import type { WatcherLedger } from '../fork-heimdall/ledger-types'
import type { Snapshot } from '../fork-heimdall/snapshot'
import { objectiveCheckFailedDeviation } from './deviation-context'
import type { IngestVerdictAction, ObjectiveAction } from './objective-actions'
import {
  decidePlannerAction,
  latestObjectiveAttempt,
  objectiveAttemptDisposition,
  objectiveAttemptReportValidation,
  objectiveNoAction,
  objectiveReportValidationDetail,
  type ObjectiveAttempt,
  type ObjectiveDecisionOutcome
} from './decision-context'
import {
  decideBlockedReview,
  decideJudgmentQualityReview,
  type ReviewBlocked
} from './decide-judgment-quality-review'
import type {
  ObjectivePendingReport,
  ObjectiveReviewRole,
  ObjectiveRevisionProjection,
  ObjectiveWorld
} from './detail-types'
import { lineageBaseIdentity } from './landing-ladder'
import {
  objectiveReviewDispatchEvidenceKey,
  objectiveVerdictIngestionEvidenceKey
} from './review-identity'

export function decideObjectiveChecks(
  snapshot: Snapshot<ObjectiveWorld>,
  ledger: WatcherLedger,
  attempts: readonly ObjectiveAttempt[],
  reports: readonly ObjectivePendingReport[],
  revision: ObjectiveRevisionProjection,
  ownerConfigured = false
): ObjectiveDecisionOutcome | null {
  const criteria = snapshot.world.plan.nodes
    .filter((node) => node.revisionId === revision.id)
    .flatMap((node) => node.criteria)
    .filter((criterion) => criterion.shellCheckable)
  const lineageIdentity = lineageBaseIdentity(snapshot.world.plan.landing, snapshot.contentIdentity)
  for (const criterion of criteria) {
    const current =
      criterion.lastCheck?.contentIdentity === lineageIdentity ? criterion.lastCheck : null
    if (current) {
      if (current.exitCode !== 0 || current.timedOut) {
        if (ownerConfigured) {
          return {
            action: null,
            deviation: objectiveCheckFailedDeviation({
              criterionId: criterion.id,
              command: criterion.checkCommand,
              exitCode: current.exitCode,
              timedOut: current.timedOut
            })
          }
        }
        return decidePlannerAction(
          snapshot,
          ledger,
          attempts,
          reports,
          'replan-after-failure',
          revision.number
        )
      }
      continue
    }
    const check = latestObjectiveAttempt(
      attempts,
      (action) =>
        action.kind === 'run-check' &&
        action.criterionId === criterion.id &&
        action.contentIdentity === snapshot.contentIdentity
    )
    if (check) {
      const disposition = objectiveAttemptDisposition(check.attempt, ledger)
      if (disposition === 'not-landed') {
        if (ownerConfigured) {
          return {
            action: null,
            deviation: objectiveCheckFailedDeviation({
              criterionId: criterion.id,
              command: criterion.checkCommand,
              exitCode: null,
              timedOut: false,
              detail: 'the check attempt itself failed to land'
            })
          }
        }
        return decidePlannerAction(
          snapshot,
          ledger,
          attempts,
          reports,
          'replan-after-failure',
          revision.number
        )
      }
      return objectiveNoAction('checks', 'check-in-flight', criterion.id)
    }
    if (!criterion.checkCommand) {
      if (ownerConfigured) {
        return {
          action: null,
          deviation: objectiveCheckFailedDeviation({
            criterionId: criterion.id,
            command: null,
            exitCode: null,
            timedOut: false,
            detail: 'criterion has no check command configured'
          })
        }
      }
      return decidePlannerAction(
        snapshot,
        ledger,
        attempts,
        reports,
        'replan-after-failure',
        revision.number
      )
    }
    return {
      action: {
        kind: 'run-check',
        capability: 'check',
        visibility: 'local',
        contentIdentity: snapshot.contentIdentity,
        evidenceKey: `${criterion.id}:${snapshot.contentIdentity}`,
        criterionId: criterion.id,
        command: criterion.checkCommand
      }
    }
  }
  return null
}

type ReviewDispatchAttempt = {
  attempt: ObjectiveAttempt['attempt']
  action: Extract<ObjectiveAction, { kind: 'dispatch-reviewer' | 'dispatch-integrator' }>
}

function reportDispatchAttempt(
  attempts: readonly ObjectiveAttempt[],
  report: ObjectivePendingReport
): ReviewDispatchAttempt | null {
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const candidate = attempts[index]
    const { action, attempt } = candidate
    if (
      attempt.dispatchId === report.dispatchId &&
      (action.kind === 'dispatch-reviewer' || action.kind === 'dispatch-integrator') &&
      action.kind === report.actionKind &&
      action.contentIdentity === report.dispatchedContentIdentity
    ) {
      return { action, attempt }
    }
  }
  return null
}

function pendingRoleReport(
  world: ObjectiveWorld,
  attempts: readonly ObjectiveAttempt[],
  reports: readonly ObjectivePendingReport[],
  revision: ObjectiveRevisionProjection,
  role: ObjectiveReviewRole
): ObjectivePendingReport | null {
  const actionKind = role === 'reviewer' ? 'dispatch-reviewer' : 'dispatch-integrator'
  const alreadyIngested = new Set(world.plan.verdicts.map((candidate) => candidate.dispatchId))
  for (const report of reports) {
    if (report.actionKind !== actionKind || alreadyIngested.has(report.dispatchId)) {
      continue
    }
    const dispatch = reportDispatchAttempt(attempts, report)
    if (
      dispatch?.action.revisionId === revision.id &&
      dispatch.action.evidenceKey ===
        objectiveReviewDispatchEvidenceKey(revision, dispatch.action.contentIdentity)
    ) {
      return report
    }
  }
  return null
}

function decideReviewRole(
  snapshot: Snapshot<ObjectiveWorld>,
  ledger: WatcherLedger,
  attempts: readonly ObjectiveAttempt[],
  reports: readonly ObjectivePendingReport[],
  revision: ObjectiveRevisionProjection,
  role: ObjectiveReviewRole
): ObjectiveDecisionOutcome | 'approved' | ReviewBlocked {
  const lineageIdentity = lineageBaseIdentity(snapshot.world.plan.landing, snapshot.contentIdentity)
  const dispatchEvidenceKey = objectiveReviewDispatchEvidenceKey(revision, snapshot.contentIdentity)
  const verdict = snapshot.world.plan.verdicts
    .filter(
      (candidate) =>
        candidate.revisionId === revision.id &&
        candidate.role === role &&
        candidate.contentIdentity === lineageIdentity
    )
    .sort((left, right) => right.atMs - left.atMs)[0]
  if (verdict) {
    return verdict.verdict === 'approve'
      ? 'approved'
      : { status: 'blocked', dispatchId: verdict.dispatchId, summary: null }
  }

  const pending = pendingRoleReport(snapshot.world, attempts, reports, revision, role)
  if (pending) {
    const report = pending
    const dispatch = reportDispatchAttempt(attempts, report)
    const dispatchValidation =
      report.reportValidation ??
      (dispatch === null ? null : objectiveAttemptReportValidation(dispatch.attempt, ledger))
    if (report.evidenceIssue === 'files-modified-malformed') {
      return {
        status: 'blocked',
        dispatchId: report.dispatchId,
        summary: report.body ?? null,
        detail:
          `report rejected: evidence-malformed; role=${role}; hostVerifiable=true\n` +
          'Worker completion filesModified must be an array of workspace-relative paths'
      }
    }
    if (dispatchValidation) {
      return {
        status: 'blocked',
        dispatchId: report.dispatchId,
        summary: report.body ?? null,
        detail: objectiveReportValidationDetail(dispatchValidation)
      }
    }
    if (report.outcome === 'failed' || report.reportPath === null) {
      return { status: 'blocked', dispatchId: report.dispatchId, summary: report.body ?? null }
    }
    const ingestionEvidenceKey = objectiveVerdictIngestionEvidenceKey(
      revision,
      role,
      report.dispatchId,
      report.dispatchedContentIdentity
    )
    const ingestion = latestObjectiveAttempt(
      attempts,
      (action) =>
        action.kind === 'ingest-verdict' &&
        action.dispatchId === report.dispatchId &&
        action.evidenceKey === ingestionEvidenceKey
    )
    if (ingestion) {
      const disposition = objectiveAttemptDisposition(ingestion.attempt, ledger)
      if (disposition === 'not-landed') {
        const validation = objectiveAttemptReportValidation(ingestion.attempt, ledger)
        return {
          status: 'blocked',
          dispatchId: report.dispatchId,
          summary: report.body ?? null,
          ...(validation === null ? {} : { detail: objectiveReportValidationDetail(validation) })
        }
      }
      return objectiveNoAction('review', 'projection-refresh-pending', report.dispatchId)
    }
    const action: IngestVerdictAction = {
      kind: 'ingest-verdict',
      capability: 'review',
      visibility: 'local',
      recovery: 'replay-safe',
      contentIdentity: snapshot.contentIdentity,
      evidenceKey: ingestionEvidenceKey,
      revisionId: revision.id,
      role,
      dispatchId: report.dispatchId,
      reportPath: report.reportPath,
      reviewedContentIdentity: report.dispatchedContentIdentity
    }
    return { action }
  }

  const actionKind = role === 'reviewer' ? 'dispatch-reviewer' : 'dispatch-integrator'
  const ingestedDispatchIds = new Set(
    snapshot.world.plan.verdicts.map((candidate) => candidate.dispatchId)
  )
  let dispatch: ObjectiveAttempt | null = null
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const candidate = attempts[index]
    if (
      candidate.action.kind === actionKind &&
      candidate.action.revisionId === revision.id &&
      candidate.action.evidenceKey ===
        objectiveReviewDispatchEvidenceKey(revision, candidate.action.contentIdentity) &&
      (candidate.attempt.dispatchId === undefined ||
        !ingestedDispatchIds.has(candidate.attempt.dispatchId))
    ) {
      dispatch = candidate
      break
    }
  }
  if (dispatch) {
    const disposition = objectiveAttemptDisposition(dispatch.attempt, ledger)
    if (disposition === 'not-landed' || disposition === 'landed') {
      const validation = objectiveAttemptReportValidation(dispatch.attempt, ledger)
      return {
        status: 'blocked',
        dispatchId: dispatch.attempt.dispatchId ?? dispatch.action.evidenceKey,
        summary: null,
        ...(validation === null ? {} : { detail: objectiveReportValidationDetail(validation) })
      }
    }
    return objectiveNoAction('review', 'review-in-flight', role)
  }

  return {
    action: {
      kind: actionKind,
      capability: 'review',
      visibility: 'local',
      contentIdentity: snapshot.contentIdentity,
      evidenceKey: dispatchEvidenceKey,
      revisionId: revision.id
    }
  }
}

function isBlocked(
  outcome: ObjectiveDecisionOutcome | 'approved' | ReviewBlocked
): outcome is ReviewBlocked {
  return typeof outcome === 'object' && 'status' in outcome && outcome.status === 'blocked'
}

export function decideObjectiveReview(
  snapshot: Snapshot<ObjectiveWorld>,
  ledger: WatcherLedger,
  attempts: readonly ObjectiveAttempt[],
  reports: readonly ObjectivePendingReport[],
  revision: ObjectiveRevisionProjection,
  ownerConfigured = false
): ObjectiveDecisionOutcome | null {
  if (snapshot.world.contract.tier === 'express') {
    return decideJudgmentQualityReview(
      snapshot,
      ledger,
      attempts,
      reports,
      revision,
      ownerConfigured
    )
  }
  const reviewer = decideReviewRole(snapshot, ledger, attempts, reports, revision, 'reviewer')
  if (isBlocked(reviewer)) {
    return decideBlockedReview(
      snapshot,
      ledger,
      attempts,
      reports,
      revision,
      'reviewer',
      reviewer,
      ownerConfigured,
      { anyTaskInRevision: true }
    )
  }
  if (reviewer !== 'approved') {
    return reviewer
  }
  if (snapshot.world.contract.tier === 'standard') {
    return decideJudgmentQualityReview(
      snapshot,
      ledger,
      attempts,
      reports,
      revision,
      ownerConfigured
    )
  }
  const integrator = decideReviewRole(snapshot, ledger, attempts, reports, revision, 'integrator')
  if (isBlocked(integrator)) {
    return decideBlockedReview(
      snapshot,
      ledger,
      attempts,
      reports,
      revision,
      'integrator',
      integrator,
      ownerConfigured,
      { anyTaskInRevision: true }
    )
  }
  return integrator === 'approved'
    ? decideJudgmentQualityReview(snapshot, ledger, attempts, reports, revision, ownerConfigured)
    : integrator
}
