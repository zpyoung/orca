import type { WatcherLedger } from '../fork-heimdall/ledger-types'
import type { Snapshot } from '../fork-heimdall/snapshot'
import { judgmentQualityReviewSubjects } from '../fork-heimdall/judgment/objective-judgment-policy'
import type { IngestVerdictAction, ObjectiveAction } from './objective-actions'
import {
  decidePlannerAction,
  latestObjectiveAttempt,
  objectiveAttemptDisposition,
  objectiveNoAction,
  type ObjectiveAttempt,
  type ObjectiveDecisionOutcome
} from './decision-context'
import type {
  ObjectivePendingReport,
  ObjectiveReviewRole,
  ObjectiveRevisionProjection,
  ObjectiveWorld
} from './detail-types'
import { lineageBaseIdentity } from './landing-ladder'
type ReviewDispatchAction = Extract<
  ObjectiveAction,
  { kind: 'dispatch-reviewer' | 'dispatch-integrator' }
>

export function decideObjectiveChecks(
  snapshot: Snapshot<ObjectiveWorld>,
  ledger: WatcherLedger,
  attempts: readonly ObjectiveAttempt[],
  reports: readonly ObjectivePendingReport[],
  revision: ObjectiveRevisionProjection
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

function reportDispatchAction(
  attempts: readonly ObjectiveAttempt[],
  report: ObjectivePendingReport
): ReviewDispatchAction | null {
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const { action, attempt } = attempts[index]
    if (
      attempt.dispatchId === report.dispatchId &&
      action.kind === report.actionKind &&
      action.contentIdentity === report.dispatchedContentIdentity &&
      (action.kind === 'dispatch-reviewer' || action.kind === 'dispatch-integrator')
    ) {
      return action
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
    const dispatch = reportDispatchAction(attempts, report)
    if (dispatch?.revisionId === revision.id) {
      return report
    }
  }
  return null
}
function decideJudgmentQualityReview(
  snapshot: Snapshot<ObjectiveWorld>,
  ledger: WatcherLedger,
  attempts: readonly ObjectiveAttempt[],
  reports: readonly ObjectivePendingReport[],
  revision: ObjectiveRevisionProjection
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
    const evidenceKey = `${sourceAttempt.action.evidenceKey}:judgment-review:${sourceAttempt.action.contentIdentity}`
    const review = latestObjectiveAttempt(
      attempts,
      (action) =>
        action.kind === 'dispatch-reviewer' &&
        action.revisionId === revision.id &&
        action.judgmentReviewOf === subjectId
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
      return decidePlannerAction(
        snapshot,
        ledger,
        attempts,
        reports,
        'replan-after-block',
        revision.number
      )
    }
    if (judgmentVerdict) {
      continue
    }
    const disposition = objectiveAttemptDisposition(review.attempt, ledger)
    const report = reports.find((candidate) => candidate.dispatchId === review.attempt.dispatchId)
    if (report?.outcome === 'succeeded' && report.reportPath !== null) {
      const ingestion = latestObjectiveAttempt(
        attempts,
        (action) => action.kind === 'ingest-verdict' && action.dispatchId === report.dispatchId
      )
      if (!ingestion) {
        return {
          action: {
            kind: 'ingest-verdict',
            capability: 'review',
            visibility: 'local',
            recovery: 'replay-safe',
            contentIdentity: snapshot.contentIdentity,
            evidenceKey: report.dispatchId,
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
      continue
    }
    if (report && (report.outcome === 'failed' || report.reportPath === null)) {
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

function decideReviewRole(
  snapshot: Snapshot<ObjectiveWorld>,
  ledger: WatcherLedger,
  attempts: readonly ObjectiveAttempt[],
  reports: readonly ObjectivePendingReport[],
  revision: ObjectiveRevisionProjection,
  role: ObjectiveReviewRole
): ObjectiveDecisionOutcome | 'approved' | 'blocked' {
  const lineageIdentity = lineageBaseIdentity(snapshot.world.plan.landing, snapshot.contentIdentity)
  const verdict = snapshot.world.plan.verdicts
    .filter(
      (candidate) =>
        candidate.revisionId === revision.id &&
        candidate.role === role &&
        candidate.contentIdentity === lineageIdentity
    )
    .sort((left, right) => right.atMs - left.atMs)[0]
  if (verdict) {
    return verdict.verdict === 'approve' ? 'approved' : 'blocked'
  }

  const pending = pendingRoleReport(snapshot.world, attempts, reports, revision, role)
  if (pending) {
    const report = pending
    if (report.outcome === 'failed' || report.reportPath === null) {
      return 'blocked'
    }
    const ingestion = latestObjectiveAttempt(
      attempts,
      (action) => action.kind === 'ingest-verdict' && action.dispatchId === report.dispatchId
    )
    if (ingestion) {
      const disposition = objectiveAttemptDisposition(ingestion.attempt, ledger)
      if (disposition === 'not-landed') {
        return 'blocked'
      }
      return objectiveNoAction('review', 'projection-refresh-pending', report.dispatchId)
    }
    const action: IngestVerdictAction = {
      kind: 'ingest-verdict',
      capability: 'review',
      visibility: 'local',
      recovery: 'replay-safe',
      contentIdentity: snapshot.contentIdentity,
      evidenceKey: report.dispatchId,
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
      return 'blocked'
    }
    return objectiveNoAction('review', 'review-in-flight', role)
  }

  return {
    action: {
      kind: actionKind,
      capability: 'review',
      visibility: 'local',
      contentIdentity: snapshot.contentIdentity,
      evidenceKey: `${revision.id}:review:${snapshot.contentIdentity}`,
      revisionId: revision.id
    }
  }
}

export function decideObjectiveReview(
  snapshot: Snapshot<ObjectiveWorld>,
  ledger: WatcherLedger,
  attempts: readonly ObjectiveAttempt[],
  reports: readonly ObjectivePendingReport[],
  revision: ObjectiveRevisionProjection
): ObjectiveDecisionOutcome | null {
  if (snapshot.world.contract.tier === 'express') {
    return decideJudgmentQualityReview(snapshot, ledger, attempts, reports, revision)
  }
  const reviewer = decideReviewRole(snapshot, ledger, attempts, reports, revision, 'reviewer')
  if (reviewer === 'blocked') {
    return decidePlannerAction(
      snapshot,
      ledger,
      attempts,
      reports,
      'replan-after-block',
      revision.number
    )
  }
  if (reviewer !== 'approved') {
    return reviewer
  }
  if (snapshot.world.contract.tier === 'standard') {
    return decideJudgmentQualityReview(snapshot, ledger, attempts, reports, revision)
  }
  const integrator = decideReviewRole(snapshot, ledger, attempts, reports, revision, 'integrator')
  if (integrator === 'blocked') {
    return decidePlannerAction(
      snapshot,
      ledger,
      attempts,
      reports,
      'replan-after-block',
      revision.number
    )
  }
  return integrator === 'approved'
    ? decideJudgmentQualityReview(snapshot, ledger, attempts, reports, revision)
    : integrator
}
