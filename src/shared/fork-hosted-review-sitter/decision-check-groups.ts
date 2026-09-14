import { makeHostedReviewEvidenceKey } from './action-identity'
import type { HostedReviewCheckSnapshot, HostedReviewSnapshot, RerunCheckAction } from './types'

export type FailedCheckGroup = {
  checkKey: string
  checks: readonly HostedReviewCheckSnapshot[]
}

/** Required checks reported against the snapshot's own head, ignoring stale carry-over. */
export function currentRequiredChecks(
  review: HostedReviewSnapshot
): readonly HostedReviewCheckSnapshot[] {
  return review.checks.filter((check) => check.required && check.headSha === review.headSha)
}

/** Failed current-head required checks, grouped by check key in a stable order. */
export function failedCheckGroups(review: HostedReviewSnapshot): readonly FailedCheckGroup[] {
  const grouped = new Map<string, HostedReviewCheckSnapshot[]>()
  for (const check of currentRequiredChecks(review)) {
    if (check.state !== 'failed') {
      continue
    }
    const existing = grouped.get(check.checkKey)
    if (existing) {
      existing.push(check)
    } else {
      grouped.set(check.checkKey, [check])
    }
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([checkKey, checks]) => ({
      checkKey,
      checks: checks.sort((left, right) => left.observationId.localeCompare(right.observationId))
    }))
}

/**
 * The checks proving a failure is deterministic rather than flaky: one shard and signature
 * reproduced on two or more runtimes. Returns null when no group clears that bar.
 */
export function deterministicFailureChecks(
  group: FailedCheckGroup
): readonly HostedReviewCheckSnapshot[] | null {
  const candidates = new Map<string, HostedReviewCheckSnapshot[]>()
  for (const check of group.checks) {
    if (!check.failureSignature || !check.shardKey || !check.runtimeKey) {
      continue
    }
    const identity = makeHostedReviewEvidenceKey([check.shardKey, check.failureSignature])
    const existing = candidates.get(identity)
    if (existing) {
      existing.push(check)
    } else {
      candidates.set(identity, [check])
    }
  }

  for (const checks of [...candidates.values()].sort((left, right) => {
    return left[0]!.observationId.localeCompare(right[0]!.observationId)
  })) {
    const runtimes = new Set(checks.map((check) => check.runtimeKey))
    if (runtimes.size >= 2) {
      return checks
    }
  }
  return null
}

/**
 * Failures observed after the rerun produced new observations. Returns null while the original
 * observations are still current, which means the rerun result has not landed yet.
 */
export function freshFailedChecksAfterRerun(
  review: HostedReviewSnapshot,
  group: FailedCheckGroup,
  rerun: RerunCheckAction
): readonly HostedReviewCheckSnapshot[] | null {
  const current = currentRequiredChecks(review).filter((check) => check.checkKey === group.checkKey)
  if (current.length === 0) {
    return null
  }
  const originalObservations = new Set(rerun.observationIds)
  if (current.some((check) => originalObservations.has(check.observationId))) {
    return null
  }
  const failures = current.filter((check) => check.state === 'failed')
  return failures.length > 0 ? failures : null
}
