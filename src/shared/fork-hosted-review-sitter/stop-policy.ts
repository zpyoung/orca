import type { StopPredicate } from '../fork-heimdall/stop-policy'
import type { WatcherLedger } from '../fork-heimdall/ledger-types'
import { getAttemptResolution } from '../fork-heimdall/ledger-queries'
import type { CheckFailedDeviation } from '../fork-heimdall/owner/deviation'
import {
  getHostedReviewAttemptDisposition,
  getHostedReviewFixAttributions,
  getLatestHostedReviewAttempts
} from './ledger-adapter'
import { currentHeadChecks } from './decision-check-groups'
import type {
  HostedReviewAttemptEntry,
  HostedReviewMergeCheckScope,
  HostedReviewSnapshot,
  HostedReviewWorld
} from './types'

export const HOSTED_REVIEW_DEFAULT_REPEAT_FIX_LIMIT = 3

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
  ledger: WatcherLedger,
  scope: HostedReviewMergeCheckScope
): readonly RepeatedOwnFixEvidence[] {
  const failures = currentHeadChecks(review, scope).filter((check) => check.state === 'failed')
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
    matches.set(attribution.publishActionId, {
      sourceHeadSha: attribution.sourceHeadSha,
      producedHeadSha: attribution.producedHeadSha,
      checkKey: attribution.checkKey,
      failureSignature: attribution.failureSignature,
      publishActionId: attribution.publishActionId
    })
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

export type RepeatedOwnFixGroup = {
  checkKey: string
  failureSignature: string
  publishActionIds: string[]
}

function groupRepeatedOwnFixEvidence(
  evidence: readonly RepeatedOwnFixEvidence[]
): RepeatedOwnFixGroup[] {
  const groups = new Map<string, RepeatedOwnFixGroup>()
  for (const entry of evidence) {
    const key = JSON.stringify([entry.checkKey, entry.failureSignature])
    const group = groups.get(key)
    if (group) {
      group.publishActionIds.push(entry.publishActionId)
    } else {
      groups.set(key, {
        checkKey: entry.checkKey,
        failureSignature: entry.failureSignature,
        publishActionIds: [entry.publishActionId]
      })
    }
  }
  return [...groups.values()].sort(
    (left, right) =>
      left.checkKey.localeCompare(right.checkKey) ||
      left.failureSignature.localeCompare(right.failureSignature)
  )
}

export function repeatedOwnFixGroups(
  review: HostedReviewSnapshot,
  ledger: WatcherLedger,
  scope: HostedReviewMergeCheckScope
): RepeatedOwnFixGroup[] {
  return groupRepeatedOwnFixEvidence(getRepeatedFailureAfterOwnFixEvidence(review, ledger, scope))
}

export function repeatedOwnFixExhausted(
  groups: readonly RepeatedOwnFixGroup[],
  limit: number
): RepeatedOwnFixGroup | null {
  return groups.find((group) => group.publishActionIds.length >= limit) ?? null
}

export function hasRepeatedFailureAfterOwnFix(
  review: HostedReviewSnapshot,
  ledger: WatcherLedger,
  scope: HostedReviewMergeCheckScope
): boolean {
  return getRepeatedFailureAfterOwnFixEvidence(review, ledger, scope).length > 0
}

export type UnverifiableReproducedFailureEvidence = {
  checkKey: string
  rerunAttemptId: string
}

/** A completed rerun still fails without a classifiable signature: the check itself, not the rerun, is unverifiable. */
export function getUnverifiableReproducedFailureEvidence(
  review: HostedReviewSnapshot,
  ledger: WatcherLedger,
  scope: HostedReviewMergeCheckScope
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
    const current = currentHeadChecks(review, scope).filter(
      (check) => check.checkKey === rerun.checkKey
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
  ledger: WatcherLedger,
  scope: HostedReviewMergeCheckScope
): boolean {
  return getUnverifiableReproducedFailureEvidence(review, ledger, scope).length > 0
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
      const repeatFixLimit =
        snapshot.world.definition.repeatFixLimit ?? HOSTED_REVIEW_DEFAULT_REPEAT_FIX_LIMIT
      const exhausted = repeatedOwnFixExhausted(
        repeatedOwnFixGroups(
          snapshot.world.review,
          ledger,
          snapshot.world.definition.mergeCheckScope
        ),
        repeatFixLimit
      )
      return exhausted
        ? {
            stop: true,
            reason: 'repeated-failure-after-own-fix',
            detail: exhausted.checkKey
          }
        : { stop: false }
    },
    deviationForFiring(_verdict, snapshot, ledger): CheckFailedDeviation {
      const repeatFixLimit =
        snapshot.world.definition.repeatFixLimit ?? HOSTED_REVIEW_DEFAULT_REPEAT_FIX_LIMIT
      const evidence = getRepeatedFailureAfterOwnFixEvidence(
        snapshot.world.review,
        ledger,
        snapshot.world.definition.mergeCheckScope
      )
      const exhausted = repeatedOwnFixExhausted(
        groupRepeatedOwnFixEvidence(evidence),
        repeatFixLimit
      )
      if (!exhausted) {
        throw new Error('Repeated own-fix predicate fired without an exhausted failure group.')
      }
      const [publishActionId] = exhausted.publishActionIds
      if (!publishActionId) {
        throw new Error('Exhausted own-fix group has no publish action.')
      }
      const primary = evidence.find(
        (entry) =>
          entry.checkKey === exhausted.checkKey &&
          entry.failureSignature === exhausted.failureSignature &&
          entry.publishActionId === publishActionId
      )
      if (!primary) {
        throw new Error('Exhausted own-fix group lost its durable publish evidence.')
      }
      return {
        kind: 'check-failed',
        criterionId: primary.checkKey,
        command: null,
        exitCode: null,
        timedOut: null,
        detail: `same failure recurred after the sitter's own fix (produced ${primary.producedHeadSha})`
      }
    }
  },
  {
    id: 'unverifiable-reproduced-failure',
    evaluate(snapshot, ledger) {
      return hasUnverifiableReproducedFailure(
        snapshot.world.review,
        ledger,
        snapshot.world.definition.mergeCheckScope
      )
        ? { stop: true, reason: 'unverifiable-reproduced-failure' }
        : { stop: false }
    },
    deviationForFiring(_verdict, snapshot, ledger): CheckFailedDeviation {
      const [primary] = getUnverifiableReproducedFailureEvidence(
        snapshot.world.review,
        ledger,
        snapshot.world.definition.mergeCheckScope
      )
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
