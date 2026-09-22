import type {
  OwnerStateBrief,
  OwnerStateBriefContext
} from '../../shared/fork-heimdall/kind-contract'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import {
  explainDesiredAction,
  type HostedReviewSitterDecisionOutcome
} from '../../shared/fork-hosted-review-sitter/decision'
import { deriveHostedReviewSitterDiscrepancies } from '../../shared/fork-hosted-review-sitter/reconciliation'
import type {
  HostedReviewCheckSnapshot,
  HostedReviewSnapshot,
  HostedReviewWorld
} from '../../shared/fork-hosted-review-sitter/types'
import { searchMinimalOmissionPrefix } from '../fork-heimdall/judgment/omission-budget-search'
import { sanitized } from '../fork-heimdall/judgment/state-projection'

type CheckBrief = {
  checkKey: string
  required: boolean
  current: boolean
  state: HostedReviewCheckSnapshot['state']
  failureSignature: string | null
}

type DeclinedSummary = { reason: string; detail: string | null } | null

type OwnerStatePayload = {
  provider: string
  reviewNumber: number
  url: string
  lifecycle: string
  headSha: string
  baseSha: string
  draft: boolean
  behindBase: boolean
  conflicts: string
  providerReadiness: HostedReviewSnapshot['providerReadiness']
  queue: HostedReviewSnapshot['queue']
  capabilities: unknown
  declined: DeclinedSummary
  considered: unknown
  discrepancies: readonly { kind: string; status: string; reason: string }[]
}

type CheckOmission = {
  count: number
  reference: 'snapshot.world.review.checks'
}

function describeDeclined(outcome: HostedReviewSitterDecisionOutcome): DeclinedSummary {
  if (outcome.action) {
    return null
  }
  return 'deviation' in outcome
    ? { reason: outcome.deviation.kind, detail: outcome.deviation.detail ?? null }
    : { reason: outcome.reason, detail: outcome.detail ?? null }
}

function buildPayloadBase(
  snapshot: Snapshot<HostedReviewWorld>,
  ledger: WatcherLedger
): OwnerStatePayload {
  const { review, definition, preparedCommit } = snapshot.world
  const outcome = explainDesiredAction(review, definition, ledger, {
    freshness: snapshot.freshness,
    preparedCommit
  })
  return {
    provider: review.provider,
    reviewNumber: review.reviewNumber,
    url: review.url,
    lifecycle: review.lifecycle,
    headSha: review.headSha,
    baseSha: review.baseSha,
    draft: review.draft,
    behindBase: review.behindBase,
    conflicts: review.conflicts,
    providerReadiness: review.providerReadiness,
    queue: review.queue,
    capabilities: definition.capabilities,
    declined: describeDeclined(outcome),
    considered: 'considered' in outcome ? outcome.considered : [],
    discrepancies: deriveHostedReviewSitterDiscrepancies(review, ledger).map((entry) => ({
      kind: entry.kind,
      status: entry.status,
      reason: entry.reason
    }))
  }
}

function isMandatoryCheck(check: CheckBrief, context: OwnerStateBriefContext | undefined): boolean {
  const triggeringCheck =
    context?.deviation.kind === 'check-failed' ? context.deviation.criterionId : null
  return check.checkKey === triggeringCheck || (check.current && check.state !== 'passed')
}

function projectPayload(
  base: OwnerStatePayload,
  checks: readonly CheckBrief[],
  omission: CheckOmission | null,
  maxBytes: number
): { text: string; fitsStateBudget: boolean } {
  const text = JSON.stringify(
    sanitized({
      ...base,
      checks,
      ...(omission ? { omissions: { checks: omission } } : {})
    })
  )
  return { text, fitsStateBudget: Buffer.byteLength(text, 'utf8') <= maxBytes }
}

/**
 * Bounds the sitter brief by dropping only stale or current-passing check summaries. Current
 * non-passing and triggering checks are mandatory display context.
 */
export function describeHostedReviewOwnerState(
  snapshot: Snapshot<HostedReviewWorld>,
  ledger: WatcherLedger,
  maxBytes: number,
  context?: OwnerStateBriefContext
): OwnerStateBrief {
  const base = buildPayloadBase(snapshot, ledger)
  const checks = snapshot.world.review.checks.map((check) => ({
    checkKey: check.checkKey,
    required: check.required,
    current: check.headSha === snapshot.world.review.headSha,
    state: check.state,
    failureSignature: check.failureSignature
  }))
  const optional = checks
    .filter((check) => !isMandatoryCheck(check, context))
    .sort((left, right) => {
      const currentOrder = Number(left.current) - Number(right.current)
      return (
        currentOrder ||
        (left.checkKey < right.checkKey ? -1 : left.checkKey > right.checkKey ? 1 : 0)
      )
    })
  const build = (dropCount: number) => {
    const omitted = new Set(optional.slice(0, dropCount))
    return projectPayload(
      base,
      checks.filter((check) => !omitted.has(check)),
      dropCount === 0
        ? null
        : {
            count: dropCount,
            reference: 'snapshot.world.review.checks'
          },
      maxBytes
    )
  }
  const full = build(0)
  if (full.fitsStateBudget || optional.length === 0) {
    return { text: full.text, truncated: false }
  }
  const found = searchMinimalOmissionPrefix(optional.length, build)
  return { text: found ? found.result.text : full.text, truncated: true }
}
