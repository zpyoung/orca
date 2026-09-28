import type { StopPredicate } from '../fork-heimdall/stop-policy'
import type { WatcherLedger } from '../fork-heimdall/ledger-types'
import { getAttemptResolution } from '../fork-heimdall/ledger-queries'
import type { CheckFailedDeviation } from '../fork-heimdall/owner/deviation'
import {
  getHostedReviewAttemptDisposition,
  getHostedReviewFixAttributions,
  getLatestHostedReviewAttempts
} from './ledger-adapter'
import type {
  HostedReviewAttemptEntry,
  HostedReviewCheckSnapshot,
  HostedReviewSnapshot,
  HostedReviewWorld
} from './types'

function currentRequiredFailures(
  review: HostedReviewSnapshot
): readonly HostedReviewCheckSnapshot[] {
  return review.checks.filter(
    (check) => check.required && check.headSha === review.headSha && check.state === 'failed'
  )
}

function producedHeadForCompletedEntry(
  entry: HostedReviewAttemptEntry,
  ledger: WatcherLedger
): string | null {
  const action = entry.action
  if (
    getHostedReviewAttemptDisposition(ledger, action) !== 'completed' ||
    (action.kind !== 'publish-fix' &&
      action.kind !== 'publish-conflict-resolution' &&
      action.kind !== 'update-branch')
  ) {
    return null
  }
  if (entry.result?.kind === 'published') {
    return entry.result.resultingHeadSha
  }
  return getAttemptResolution(ledger, entry.attemptId)?.effect === 'landed' &&
    (action.kind === 'publish-fix' || action.kind === 'publish-conflict-resolution')
    ? action.preparedCommitSha
    : null
}

function sitterOwnedAncestorHeads(
  currentHeadSha: string,
  ledger: WatcherLedger
): ReadonlySet<string> {
  const parentsByProducedHead = new Map<string, string[]>()
  for (const attribution of getHostedReviewFixAttributions(ledger)) {
    const parents = parentsByProducedHead.get(attribution.producedHeadSha)
    if (parents) {
      parents.push(attribution.sourceHeadSha)
    } else {
      parentsByProducedHead.set(attribution.producedHeadSha, [attribution.sourceHeadSha])
    }
  }
  for (const entry of getLatestHostedReviewAttempts(ledger)) {
    const producedHeadSha = producedHeadForCompletedEntry(entry, ledger)
    if (!producedHeadSha) {
      continue
    }
    const parents = parentsByProducedHead.get(producedHeadSha)
    if (parents) {
      parents.push(entry.action.headSha)
    } else {
      parentsByProducedHead.set(producedHeadSha, [entry.action.headSha])
    }
  }

  const ancestors = new Set([currentHeadSha])
  const pending = [currentHeadSha]
  for (let index = 0; index < pending.length; index += 1) {
    for (const parent of parentsByProducedHead.get(pending[index]!) ?? []) {
      if (ancestors.has(parent)) {
        continue
      }
      ancestors.add(parent)
      pending.push(parent)
    }
  }
  return ancestors
}

export type RepeatedOwnFixEvidence = {
  sourceHeadSha: string
  producedHeadSha: string
  checkKey: string
  failureSignature: string
  publishActionId: string
}

export function getRepeatedFailureAfterOwnFixEvidence(
  review: HostedReviewSnapshot,
  ledger: WatcherLedger
): readonly RepeatedOwnFixEvidence[] {
  const failures = currentRequiredFailures(review)
  const ownedAncestors = sitterOwnedAncestorHeads(review.headSha, ledger)
  const matches = new Map<string, RepeatedOwnFixEvidence>()
  for (const attribution of getHostedReviewFixAttributions(ledger)) {
    if (!ownedAncestors.has(attribution.producedHeadSha)) {
      continue
    }
    const repeated = failures.some(
      (check) =>
        check.checkKey === attribution.checkKey &&
        check.failureSignature === attribution.failureSignature
    )
    if (!repeated) {
      continue
    }
    matches.set(attribution.publishActionId, attribution)
  }
  for (const entry of getLatestHostedReviewAttempts(ledger)) {
    if (entry.action.kind !== 'publish-fix') {
      continue
    }
    const producedHeadSha = producedHeadForCompletedEntry(entry, ledger)
    if (!producedHeadSha || !ownedAncestors.has(producedHeadSha)) {
      continue
    }
    const action = entry.action
    const repeated = failures.some(
      (check) =>
        check.checkKey === action.checkKey && check.failureSignature === action.failureSignature
    )
    if (!repeated || matches.has(entry.attemptId)) {
      continue
    }
    matches.set(entry.attemptId, {
      sourceHeadSha: action.headSha,
      producedHeadSha,
      checkKey: action.checkKey,
      failureSignature: action.failureSignature,
      publishActionId: entry.attemptId
    })
  }
  return [...matches.values()]
}

export function hasRepeatedFailureAfterOwnFix(
  review: HostedReviewSnapshot,
  ledger: WatcherLedger
): boolean {
  return getRepeatedFailureAfterOwnFixEvidence(review, ledger).length > 0
}

export type UnverifiableReproducedFailureEvidence = {
  checkKey: string
  rerunAttemptId: string
}

/** A completed rerun still fails without a classifiable signature: the check itself, not the rerun, is unverifiable. */
export function getUnverifiableReproducedFailureEvidence(
  review: HostedReviewSnapshot,
  ledger: WatcherLedger
): readonly UnverifiableReproducedFailureEvidence[] {
  const evidence: UnverifiableReproducedFailureEvidence[] = []
  for (const entry of getLatestHostedReviewAttempts(ledger)) {
    if (
      getHostedReviewAttemptDisposition(ledger, entry.action) !== 'completed' ||
      entry.action.kind !== 'rerun-check' ||
      entry.action.headSha !== review.headSha
    ) {
      continue
    }
    const rerun = entry.action
    const original = new Set(rerun.observationIds)
    const current = review.checks.filter(
      (check) =>
        check.required && check.headSha === review.headSha && check.checkKey === rerun.checkKey
    )
    if (current.length === 0 || current.some((check) => original.has(check.observationId))) {
      continue
    }
    const failures = current.filter((check) => check.state === 'failed')
    if (failures.length > 0 && failures.every((check) => check.failureSignature === null)) {
      evidence.push({ checkKey: rerun.checkKey, rerunAttemptId: entry.attemptId })
    }
  }
  return evidence
}

export function hasUnverifiableReproducedFailure(
  review: HostedReviewSnapshot,
  ledger: WatcherLedger
): boolean {
  return getUnverifiableReproducedFailureEvidence(review, ledger).length > 0
}

export const hostedReviewLifecycleTerminalPredicate: StopPredicate<HostedReviewWorld> = {
  id: 'hosted-review-lifecycle-closed',
  disposition: 'terminal',
  evaluate(snapshot) {
    const lifecycle = snapshot.world.review.lifecycle
    return lifecycle === 'open'
      ? { stop: false }
      : { stop: true, reason: `review ${lifecycle}`, detail: snapshot.world.review.headSha }
  }
}

export const HOSTED_REVIEW_STOP_PREDICATES: readonly StopPredicate<HostedReviewWorld>[] = [
  hostedReviewLifecycleTerminalPredicate,
  {
    id: 'repeated-failure-after-own-fix',
    evaluate(snapshot, ledger) {
      const evidence = getRepeatedFailureAfterOwnFixEvidence(snapshot.world.review, ledger)
      return evidence.length === 0
        ? { stop: false }
        : {
            stop: true,
            reason: 'repeated-failure-after-own-fix',
            detail: evidence
              .map((entry) => entry.checkKey)
              .sort()
              .join(',')
          }
    },
    deviationForFiring(_verdict, snapshot, ledger): CheckFailedDeviation {
      // re-derived rather than parsed back out of `verdict.detail`; guaranteed non-empty since
      // `evaluate` only fires with at least one entry, using the same snapshot and ledger
      const [primary] = getRepeatedFailureAfterOwnFixEvidence(snapshot.world.review, ledger)
      return {
        kind: 'check-failed',
        criterionId: primary!.checkKey,
        command: null,
        exitCode: null,
        timedOut: null,
        detail: `same failure recurred after the sitter's own fix (produced ${primary!.producedHeadSha})`
      }
    }
  },
  {
    id: 'unverifiable-reproduced-failure',
    evaluate(snapshot, ledger) {
      return hasUnverifiableReproducedFailure(snapshot.world.review, ledger)
        ? { stop: true, reason: 'unverifiable-reproduced-failure' }
        : { stop: false }
    },
    deviationForFiring(_verdict, snapshot, ledger): CheckFailedDeviation {
      const [primary] = getUnverifiableReproducedFailureEvidence(snapshot.world.review, ledger)
      return {
        kind: 'check-failed',
        criterionId: primary!.checkKey,
        command: null,
        exitCode: null,
        timedOut: null,
        detail: 'a rerun reproduced this failure with no classifiable signature'
      }
    }
  }
]
