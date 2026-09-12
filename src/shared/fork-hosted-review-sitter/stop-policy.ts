import { getLatestActionTransitions } from './ledger'
import type {
  HostedReviewCheckSnapshot,
  HostedReviewSitterLedger,
  HostedReviewSnapshot
} from './types'

function currentRequiredFailures(
  review: HostedReviewSnapshot
): readonly HostedReviewCheckSnapshot[] {
  return review.checks.filter(
    (check) => check.required && check.headSha === review.headSha && check.state === 'failed'
  )
}

function sitterOwnedAncestorHeads(
  currentHeadSha: string,
  ledger: HostedReviewSitterLedger
): ReadonlySet<string> {
  const parentsByProducedHead = new Map<string, string[]>()
  for (const entry of ledger.entries) {
    if (entry.kind !== 'fix-attribution') {
      continue
    }
    const parents = parentsByProducedHead.get(entry.producedHeadSha)
    if (parents) {
      parents.push(entry.sourceHeadSha)
    } else {
      parentsByProducedHead.set(entry.producedHeadSha, [entry.sourceHeadSha])
    }
  }
  for (const entry of getLatestActionTransitions(ledger)) {
    const action = entry.action
    const carriesOwnHead =
      action.kind === 'publish-fix' ||
      action.kind === 'publish-conflict-resolution' ||
      action.kind === 'update-branch'
    if (entry.state !== 'completed' || !carriesOwnHead || entry.result?.kind !== 'published') {
      continue
    }
    const parents = parentsByProducedHead.get(entry.result.resultingHeadSha)
    if (parents) {
      parents.push(action.headSha)
    } else {
      parentsByProducedHead.set(entry.result.resultingHeadSha, [action.headSha])
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
  ledger: HostedReviewSitterLedger
): readonly RepeatedOwnFixEvidence[] {
  const failures = currentRequiredFailures(review)
  const ownedAncestors = sitterOwnedAncestorHeads(review.headSha, ledger)
  const matches = new Map<string, RepeatedOwnFixEvidence>()
  for (const entry of ledger.entries) {
    if (entry.kind !== 'fix-attribution' || !ownedAncestors.has(entry.producedHeadSha)) {
      continue
    }
    const repeated = failures.some(
      (check) =>
        check.checkKey === entry.checkKey && check.failureSignature === entry.failureSignature
    )
    if (!repeated) {
      continue
    }
    matches.set(entry.publishActionId, {
      sourceHeadSha: entry.sourceHeadSha,
      producedHeadSha: entry.producedHeadSha,
      checkKey: entry.checkKey,
      failureSignature: entry.failureSignature,
      publishActionId: entry.publishActionId
    })
  }
  for (const entry of getLatestActionTransitions(ledger)) {
    if (
      entry.state !== 'completed' ||
      entry.action.kind !== 'publish-fix' ||
      entry.result?.kind !== 'published' ||
      !ownedAncestors.has(entry.result.resultingHeadSha)
    ) {
      continue
    }
    const action = entry.action
    const repeated = failures.some(
      (check) =>
        check.checkKey === action.checkKey && check.failureSignature === action.failureSignature
    )
    if (!repeated || matches.has(entry.actionId)) {
      continue
    }
    matches.set(entry.actionId, {
      sourceHeadSha: action.headSha,
      producedHeadSha: entry.result.resultingHeadSha,
      checkKey: action.checkKey,
      failureSignature: action.failureSignature,
      publishActionId: entry.actionId
    })
  }
  return [...matches.values()]
}

export function hasRepeatedFailureAfterOwnFix(
  review: HostedReviewSnapshot,
  ledger: HostedReviewSitterLedger
): boolean {
  return getRepeatedFailureAfterOwnFixEvidence(review, ledger).length > 0
}

export function hasUnverifiableReproducedFailure(
  review: HostedReviewSnapshot,
  ledger: HostedReviewSitterLedger
): boolean {
  return getLatestActionTransitions(ledger).some((entry) => {
    if (
      entry.state !== 'completed' ||
      entry.action.kind !== 'rerun-check' ||
      entry.action.headSha !== review.headSha
    ) {
      return false
    }
    const rerun = entry.action
    const original = new Set(rerun.observationIds)
    const current = review.checks.filter(
      (check) =>
        check.required && check.headSha === review.headSha && check.checkKey === rerun.checkKey
    )
    if (current.length === 0 || current.some((check) => original.has(check.observationId))) {
      return false
    }
    const failures = current.filter((check) => check.state === 'failed')
    return failures.length > 0 && failures.every((check) => check.failureSignature === null)
  })
}
