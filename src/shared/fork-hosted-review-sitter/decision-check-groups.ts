import { makeHostedReviewEvidenceKey } from './action-identity'
import type {
  HostedReviewCheckSnapshot,
  HostedReviewMergeCheckScope,
  HostedReviewSnapshot,
  RerunCheckAction
} from './types'

export type FailedCheckGroup = {
  checkKey: string
  checks: readonly HostedReviewCheckSnapshot[]
}

/** Scope membership is shared by failure recovery and merge readiness. */
export function isCheckInMergeScope(
  check: HostedReviewCheckSnapshot,
  scope: HostedReviewMergeCheckScope
): boolean {
  return scope === 'all' || check.required
}
/** External statuses and trigger jobs have no universally safe job-rerun target. */
export function requiresOwnerForCheckRecovery(
  review: HostedReviewSnapshot,
  check: HostedReviewCheckSnapshot,
  scope: HostedReviewMergeCheckScope
): boolean {
  if (review.provider === 'gitlab' && check.checkId.startsWith('bridge:')) {
    return true
  }
  if (scope !== 'all' || check.required) {
    return false
  }
  return review.provider === 'github'
    ? check.checkId.startsWith('status:')
    : check.checkId.startsWith('status-check:')
}

export function groupRequiresOwnerForRecovery(
  review: HostedReviewSnapshot,
  group: FailedCheckGroup,
  scope: HostedReviewMergeCheckScope
): boolean {
  return group.checks.some((check) => requiresOwnerForCheckRecovery(review, check, scope))
}

/** The failure the sitter recovers first: one it can act on itself, else the first in order. */
export function primaryFailedCheckGroup(
  review: HostedReviewSnapshot,
  scope: HostedReviewMergeCheckScope
): FailedCheckGroup | undefined {
  const groups = failedCheckGroups(review, scope)
  return groups.find((group) => !groupRequiresOwnerForRecovery(review, group, scope)) ?? groups[0]
}

/** Checks selected for the current head, ignoring stale optional carry-over. */
export function currentHeadChecks(
  review: HostedReviewSnapshot,
  scope: HostedReviewMergeCheckScope
): readonly HostedReviewCheckSnapshot[] {
  return review.checks.filter(
    (check) => check.headSha === review.headSha && isCheckInMergeScope(check, scope)
  )
}

/** Required evidence stays strict; all-scope permits only skipped optional checks. */
export function areCurrentHeadChecksGreen(
  review: HostedReviewSnapshot,
  scope: HostedReviewMergeCheckScope
): boolean {
  if (!review.checksComplete) {
    return false
  }
  for (const check of review.checks) {
    if (!isCheckInMergeScope(check, scope)) {
      continue
    }
    if (check.headSha !== review.headSha) {
      if (check.required) {
        return false
      }
      continue
    }
    if (
      check.state !== 'passed' &&
      !(scope === 'all' && !check.required && check.state === 'skipped')
    ) {
      return false
    }
  }
  return true
}

/** Failed current-head checks in scope, grouped by check key in a stable order. */
export function failedCheckGroups(
  review: HostedReviewSnapshot,
  scope: HostedReviewMergeCheckScope
): readonly FailedCheckGroup[] {
  const grouped = new Map<string, HostedReviewCheckSnapshot[]>()
  for (const check of currentHeadChecks(review, scope)) {
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
  rerun: RerunCheckAction,
  scope: HostedReviewMergeCheckScope
): readonly HostedReviewCheckSnapshot[] | null {
  const current = currentHeadChecks(review, scope).filter(
    (check) => check.checkKey === group.checkKey
  )
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
