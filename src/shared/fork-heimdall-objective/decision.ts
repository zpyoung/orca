import type { WatcherLedger } from '../fork-heimdall/ledger-types'
import type { Snapshot } from '../fork-heimdall/snapshot'
import { objectiveLandingFailedDeviation } from './deviation-context'
import {
  activeObjectiveRevision,
  decidePlannerAction,
  latestObjectiveAttempt,
  objectiveAttempts,
  objectiveAttemptDisposition,
  objectiveNoAction,
  OBJECTIVE_LANDING_REVIEW_RETRY_CAP,
  projectObjectiveReports,
  type ObjectiveAttempt,
  type ObjectiveDecisionOutcome,
  type ObjectiveNoActionReason
} from './decision-context'
import { decideObjectiveGates } from './decide-gates'
import { decideObjectiveNodes } from './decide-nodes'
import { decideObjectivePlan } from './decide-plan'
import { decideObjectiveChecks, decideObjectiveReview } from './decide-review'
import type { ObjectiveLandingProjection, ObjectiveWorld } from './detail-types'
import { highestReachedRung, nextRung, reachedRungs, stopRungForBar } from './landing-ladder'

export type { ObjectiveDecisionOutcome, ObjectiveNoActionReason }
export { projectObjectiveReports }
export {
  deriveObjectiveLanes,
  objectiveLaneForTask,
  objectiveParallelSlotState,
  objectiveRemainingChainLengths,
  prioritizeReadyObjectiveTaskKeys
} from './parallel-scheduling'
export type {
  ObjectiveLane,
  ObjectiveLaneOptions,
  ObjectiveParallelSlotState,
  ObjectiveSchedulingNode
} from './parallel-scheduling'

function latestLandingEntry(
  landing: readonly ObjectiveLandingProjection[],
  rung: ObjectiveLandingProjection['rung'],
  contentIdentity: string
): ObjectiveLandingProjection | null {
  let latest: ObjectiveLandingProjection | null = null
  for (const entry of landing) {
    if (
      entry.rung === rung &&
      entry.contentIdentity === contentIdentity &&
      (latest === null || entry.atMs > latest.atMs)
    ) {
      latest = entry
    }
  }
  return latest
}

function decideNextLandingRung(
  snapshot: Snapshot<ObjectiveWorld>,
  ledger: WatcherLedger,
  attempts: readonly ObjectiveAttempt[],
  highest: ObjectiveLandingProjection['rung']
): ObjectiveDecisionOutcome {
  const contentIdentity = snapshot.contentIdentity
  const next = nextRung(highest, snapshot.world.contract.landingBar)
  if (next === null) {
    return objectiveNoAction('landing', 'landed-at-bar', snapshot.world.contract.landingBar)
  }
  const actionKind =
    next === 'committed-local-branch'
      ? 'commit-local-branch'
      : next === 'pushed-ref'
        ? 'push-ref'
        : 'open-hosted-review'
  const priorAttempt = latestObjectiveAttempt(
    attempts,
    (action) => action.kind === actionKind && action.contentIdentity === contentIdentity
  )
  if (priorAttempt && objectiveAttemptDisposition(priorAttempt.attempt, ledger) !== 'not-landed') {
    return objectiveNoAction('landing', 'landing-in-flight', next)
  }

  const preceding = latestLandingEntry(snapshot.world.plan.landing, highest, contentIdentity)
  if (!preceding) {
    return objectiveNoAction('landing', 'projection-refresh-pending', highest)
  }
  if (next === 'committed-local-branch') {
    const { branch, headSha, worktreeContentDigest } = snapshot.world.landingContext
    if (branch === null || headSha === null) {
      return objectiveNoAction('landing', 'branch-not-attached')
    }
    if (worktreeContentDigest === null) {
      return objectiveNoAction('landing', 'projection-refresh-pending')
    }
    const evidenceKey = `committed-local-branch:${contentIdentity}`
    return {
      action: {
        kind: 'commit-local-branch',
        capability: 'land',
        visibility: 'local',
        recovery: 'replay-safe',
        contentIdentity,
        evidenceKey,
        rung: 'committed-local-branch',
        revisionId: preceding.revisionId,
        branch,
        headSha,
        worktreeContentDigest,
        fromContentIdentity: contentIdentity,
        attemptTrailer: evidenceKey
      }
    }
  }
  if (next === 'pushed-ref') {
    const pushTarget = snapshot.world.landingContext.pushTarget
    if (pushTarget === null || preceding.commitSha === undefined) {
      return objectiveNoAction('landing', 'push-target-unavailable')
    }
    const evidenceKey = `pushed-ref:${preceding.commitSha}:${pushTarget.remote}/${pushTarget.branch}:${pushTarget.remoteSha}`
    return {
      action: {
        kind: 'push-ref',
        capability: 'land',
        visibility: 'external',
        contentIdentity,
        evidenceKey,
        rung: 'pushed-ref',
        revisionId: preceding.revisionId,
        branch: pushTarget.branch,
        remote: pushTarget.remote,
        commitSha: preceding.commitSha,
        expectedState: {
          target: `${pushTarget.remote}/${pushTarget.branch}`,
          before: pushTarget.remoteSha
        }
      }
    }
  }

  const hostedReview = snapshot.world.landingContext.hostedReview
  if (hostedReview === null || hostedReview.base === null) {
    return objectiveNoAction('landing', 'base-branch-unresolvable')
  }
  if (preceding.branch === undefined || preceding.commitSha === undefined) {
    return objectiveNoAction('landing', 'projection-refresh-pending', highest)
  }
  const evidenceKey = `hosted-review:${hostedReview.provider}:${preceding.branch}:${preceding.commitSha}`
  const retryPrefix = `${evidenceKey}:retry-`
  let notLandedAttempts = 0
  for (const candidate of attempts) {
    if (
      candidate.action.kind !== 'open-hosted-review' ||
      candidate.action.contentIdentity !== contentIdentity ||
      (candidate.action.evidenceKey !== evidenceKey &&
        !candidate.action.evidenceKey.startsWith(retryPrefix))
    ) {
      continue
    }
    if (objectiveAttemptDisposition(candidate.attempt, ledger) === 'not-landed') {
      notLandedAttempts += 1
    }
  }
  if (notLandedAttempts > OBJECTIVE_LANDING_REVIEW_RETRY_CAP) {
    return objectiveNoAction('landing', 'landing-retry-exhausted', next)
  }
  const retryEvidenceKey =
    notLandedAttempts === 0 ? evidenceKey : `${evidenceKey}:retry-${notLandedAttempts}`
  return {
    action: {
      kind: 'open-hosted-review',
      capability: 'land',
      visibility: 'external',
      contentIdentity,
      evidenceKey: retryEvidenceKey,
      rung: 'hosted-review',
      revisionId: preceding.revisionId,
      branch: preceding.branch,
      base: hostedReview.base,
      headSha: preceding.commitSha,
      provider: hostedReview.provider,
      expectedState: {
        target: `${hostedReview.provider}:${hostedReview.repoKey}:${preceding.branch}`,
        before: 'no-review'
      }
    }
  }
}

export function decideObjective(
  snapshot: Snapshot<ObjectiveWorld>,
  ledger: WatcherLedger,
  ownerConfigured = false
): ObjectiveDecisionOutcome {
  const attempts = objectiveAttempts(ledger)
  const landing = snapshot.world.plan.landing
  const reached = reachedRungs(landing, snapshot.contentIdentity)
  const highest = highestReachedRung(landing, snapshot.contentIdentity)
  const stop = stopRungForBar(snapshot.world.contract.landingBar)
  if (reached.has(stop)) {
    return objectiveNoAction('landing', 'landed-at-bar', snapshot.world.contract.landingBar)
  }
  if (highest !== null && reached.has('files-on-disk')) {
    return decideNextLandingRung(snapshot, ledger, attempts, highest)
  }

  const reports = projectObjectiveReports(ledger)
  const planDecision = decideObjectivePlan(snapshot, ledger, attempts, reports, ownerConfigured)
  if (planDecision) {
    return planDecision
  }
  const revision = activeObjectiveRevision(snapshot.world)
  if (!revision) {
    return objectiveNoAction('plan', 'projection-refresh-pending')
  }
  const nodeDecision = decideObjectiveNodes(
    snapshot,
    ledger,
    attempts,
    reports,
    revision,
    ownerConfigured
  )
  if (nodeDecision) {
    return nodeDecision
  }
  const checkDecision = decideObjectiveChecks(
    snapshot,
    ledger,
    attempts,
    reports,
    revision,
    ownerConfigured
  )
  if (checkDecision) {
    return checkDecision
  }
  const gateDecision = decideObjectiveGates(
    snapshot,
    ledger,
    attempts,
    reports,
    revision,
    ownerConfigured
  )
  if (gateDecision) {
    return gateDecision
  }
  const reviewDecision = decideObjectiveReview(
    snapshot,
    ledger,
    attempts,
    reports,
    revision,
    ownerConfigured
  )
  if (reviewDecision) {
    return reviewDecision
  }

  const landingAttempt = latestObjectiveAttempt(
    attempts,
    (action) =>
      action.kind === 'record-landing' && action.contentIdentity === snapshot.contentIdentity
  )
  if (landingAttempt) {
    if (objectiveAttemptDisposition(landingAttempt.attempt, ledger) === 'not-landed') {
      if (ownerConfigured) {
        return {
          action: null,
          deviation: objectiveLandingFailedDeviation({
            rung: 'files-on-disk',
            contentIdentity: snapshot.contentIdentity,
            reason: landingAttempt.attempt.reason ?? null
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
    return objectiveNoAction('landing', 'landing-in-flight', snapshot.contentIdentity)
  }
  return {
    action: {
      kind: 'record-landing',
      capability: 'land',
      visibility: 'local',
      recovery: 'replay-safe',
      contentIdentity: snapshot.contentIdentity,
      evidenceKey: `files-on-disk:${snapshot.contentIdentity}`,
      rung: 'files-on-disk',
      revisionId: revision.id
    }
  }
}

export const computeObjectiveAction = decideObjective
