import { judgmentQualityReviewSubjects } from '../fork-heimdall/judgment/objective-judgment-policy'
import type { WatcherLedger } from '../fork-heimdall/ledger-types'
import type { Snapshot } from '../fork-heimdall/snapshot'
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
import { objectiveReviewBlockedDeviation } from './deviation-context'
import type {
  ObjectivePendingReport,
  ObjectiveReviewRole,
  ObjectiveRevisionProjection,
  ObjectiveWorld
} from './detail-types'
import {
  objectiveJudgmentReviewEvidenceKey,
  objectiveVerdictIngestionEvidenceKey
} from './review-identity'

export type ReviewBlocked = {
  status: 'blocked'
  dispatchId: string
  summary: string | null
  detail?: string
}

export function decideBlockedReview(
  snapshot: Snapshot<ObjectiveWorld>,
  ledger: WatcherLedger,
  attempts: readonly ObjectiveAttempt[],
  reports: readonly ObjectivePendingReport[],
  revision: ObjectiveRevisionProjection,
  role: ObjectiveReviewRole,
  blocked: ReviewBlocked,
  ownerConfigured: boolean
): ObjectiveDecisionOutcome {
  if (ownerConfigured) {
    return {
      action: null,
      deviation: objectiveReviewBlockedDeviation({
        role,
        dispatchId: blocked.dispatchId,
        summary: blocked.summary,
        ...(blocked.detail === undefined ? {} : { detail: blocked.detail })
      })
    }
  }
  return decidePlannerAction(
    snapshot,
    ledger,
    attempts,
    reports,
    'replan-after-block',
    revision.number
  )
}

export function decideJudgmentQualityReview(
  snapshot: Snapshot<ObjectiveWorld>,
  ledger: WatcherLedger,
  attempts: readonly ObjectiveAttempt[],
  reports: readonly ObjectivePendingReport[],
  revision: ObjectiveRevisionProjection,
  ownerConfigured: boolean
): ObjectiveDecisionOutcome | null {
  const verdictByDispatchId = new Map(
    snapshot.world.plan.verdicts.map((candidate) => [candidate.dispatchId, candidate])
  )
  for (const subjectId of judgmentQualityReviewSubjects(snapshot.world)) {
    const sourceAttempt = attempts.find(
      (candidate) =>
        candidate.attempt.dispatchId === subjectId &&
        (candidate.action.kind === 'dispatch-node' ||
          candidate.action.kind === 'dispatch-reviewer' ||
          candidate.action.kind === 'dispatch-integrator') &&
        candidate.action.revisionId === revision.id
    )
    if (!sourceAttempt) {
      continue
    }
    const evidenceKey = objectiveJudgmentReviewEvidenceKey(
      revision,
      sourceAttempt.action.evidenceKey,
      sourceAttempt.action.contentIdentity
    )
    const review = latestObjectiveAttempt(
      attempts,
      (action) =>
        action.kind === 'dispatch-reviewer' &&
        action.revisionId === revision.id &&
        action.judgmentReviewOf === subjectId &&
        action.evidenceKey === evidenceKey
    )
    if (!review) {
      return {
        action: {
          kind: 'dispatch-reviewer',
          capability: 'review',
          visibility: 'local',
          contentIdentity: snapshot.contentIdentity,
          evidenceKey,
          revisionId: revision.id,
          judgmentReviewOf: subjectId
        }
      }
    }
    const judgmentVerdict =
      review.attempt.dispatchId === undefined
        ? undefined
        : verdictByDispatchId.get(review.attempt.dispatchId)
    if (judgmentVerdict?.verdict === 'block') {
      const ownerApprovedReviewerStage = snapshot.world.plan.verdicts.some(
        (candidate) =>
          candidate.revisionId === revision.id &&
          candidate.role === 'reviewer' &&
          candidate.verdict === 'approve' &&
          candidate.synthesizedByOwner === true
      )
      if (ownerApprovedReviewerStage) {
        continue
      }
      return decideBlockedReview(
        snapshot,
        ledger,
        attempts,
        reports,
        revision,
        'reviewer',
        { status: 'blocked', dispatchId: judgmentVerdict.dispatchId, summary: null },
        ownerConfigured
      )
    }
    if (judgmentVerdict) {
      continue
    }
    const disposition = objectiveAttemptDisposition(review.attempt, ledger)
    const report = reports.find((candidate) => candidate.dispatchId === review.attempt.dispatchId)
    const reportValidation =
      report?.reportValidation ?? objectiveAttemptReportValidation(review.attempt, ledger)
    if (
      report &&
      (report.evidenceIssue === 'files-modified-malformed' || reportValidation !== null)
    ) {
      if (ownerConfigured) {
        const detail =
          report.evidenceIssue === 'files-modified-malformed'
            ? 'report rejected: evidence-malformed; role=reviewer; hostVerifiable=true\nWorker completion filesModified must be an array of workspace-relative paths'
            : reportValidation === null
              ? 'report validation unavailable'
              : objectiveReportValidationDetail(reportValidation)
        return decideBlockedReview(
          snapshot,
          ledger,
          attempts,
          reports,
          revision,
          'reviewer',
          {
            status: 'blocked',
            dispatchId: report.dispatchId,
            summary: report.body ?? null,
            detail
          },
          true
        )
      }
      continue
    }
    if (report?.outcome === 'succeeded' && report.reportPath !== null) {
      const ingestionEvidenceKey = objectiveVerdictIngestionEvidenceKey(
        revision,
        'reviewer',
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
      if (!ingestion) {
        return {
          action: {
            kind: 'ingest-verdict',
            capability: 'review',
            visibility: 'local',
            recovery: 'replay-safe',
            contentIdentity: snapshot.contentIdentity,
            evidenceKey: ingestionEvidenceKey,
            revisionId: revision.id,
            role: 'reviewer',
            dispatchId: report.dispatchId,
            reportPath: report.reportPath,
            reviewedContentIdentity: report.dispatchedContentIdentity
          }
        }
      }
      const ingestionDisposition = objectiveAttemptDisposition(ingestion.attempt, ledger)
      if (ingestionDisposition === 'in-flight' || ingestionDisposition === 'indeterminate') {
        return objectiveNoAction('review', 'projection-refresh-pending', report.dispatchId)
      }
      if (ingestionDisposition === 'not-landed' && ownerConfigured) {
        const validation = objectiveAttemptReportValidation(ingestion.attempt, ledger)
        return decideBlockedReview(
          snapshot,
          ledger,
          attempts,
          reports,
          revision,
          'reviewer',
          {
            status: 'blocked',
            dispatchId: report.dispatchId,
            summary: report.body ?? null,
            ...(validation === null ? {} : { detail: objectiveReportValidationDetail(validation) })
          },
          true
        )
      }
      continue
    }
    if (report && (report.outcome === 'failed' || report.reportPath === null)) {
      if (ownerConfigured) {
        return decideBlockedReview(
          snapshot,
          ledger,
          attempts,
          reports,
          revision,
          'reviewer',
          { status: 'blocked', dispatchId: report.dispatchId, summary: report.body ?? null },
          true
        )
      }
      continue
    }
    if (
      disposition === 'in-flight' ||
      disposition === 'indeterminate' ||
      disposition === 'landed'
    ) {
      return objectiveNoAction('review', 'review-in-flight', evidenceKey)
    }
    // One failed disagreement review consumes this bounded review opportunity. It never rejects
    // the successful worker claim and never spawns an unbounded retry loop.
  }
  return null
}
