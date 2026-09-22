import type { ObjectiveReviewRole, ObjectiveRevisionProjection } from './detail-types'

function effectivePlanIdentity(revision: ObjectiveRevisionProjection): string {
  return `${revision.id}:${revision.digest}`
}

export function objectiveReviewDispatchEvidenceKey(
  revision: ObjectiveRevisionProjection,
  contentIdentity: string
): string {
  return `${effectivePlanIdentity(revision)}:review:${contentIdentity}`
}

export function objectiveJudgmentReviewEvidenceKey(
  revision: ObjectiveRevisionProjection,
  sourceEvidenceKey: string,
  sourceContentIdentity: string
): string {
  return `${effectivePlanIdentity(revision)}:${sourceEvidenceKey}:judgment-review:${sourceContentIdentity}`
}

export function objectiveVerdictIngestionEvidenceKey(
  revision: ObjectiveRevisionProjection,
  role: ObjectiveReviewRole,
  dispatchId: string,
  reviewedContentIdentity: string
): string {
  return `${effectivePlanIdentity(revision)}:${role}:ingest:${dispatchId}:${reviewedContentIdentity}`
}
