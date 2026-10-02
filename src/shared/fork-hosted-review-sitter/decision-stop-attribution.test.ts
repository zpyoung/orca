import { describe, expect, it } from 'vitest'
import type { WatcherLedger } from '../fork-heimdall/ledger-types'
import { evaluateStopPredicates } from '../fork-heimdall/stop-policy'
import { hostedReviewAttemptFingerprint, hostedReviewContentIdentity } from './action-identity'
import { deriveHostedReviewSitterDiscrepancies } from './reconciliation'
import { HOSTED_REVIEW_STOP_PREDICATES } from './stop-policy'
import type {
  HostedReviewCheckSnapshot,
  HostedReviewSitterAction,
  HostedReviewSitterActionResult,
  HostedReviewSitterDefinition,
  HostedReviewSnapshot
} from './types'

type TestReview = HostedReviewSnapshot & {
  observedAtMs: number
  freshness: 'live' | 'cached'
}

type ActionLedgerEntry = {
  kind: 'action'
  eventId: string
  actionId: string
  atMs: number
  action: HostedReviewSitterAction
  state: 'attempted' | 'running' | 'completed' | 'failed'
  effect?: 'landed' | 'not-landed' | 'indeterminate'
  result?: HostedReviewSitterActionResult
  reason?: string
}

type FixAttributionLedgerEntry = {
  kind: 'fix-attribution'
  eventId: string
  atMs: number
  sourceHeadSha: string
  producedHeadSha: string
  preparedCommitSha: string
  checkKey: string
  failureSignature: string
  publishActionId: string
}

type AttemptResolutionLedgerEntry = {
  kind: 'attempt-resolved'
  eventId: string
  actionId: string
  atMs: number
  effect: 'landed' | 'not-landed'
  evidence: unknown
}

type TestLedgerEntry = ActionLedgerEntry | AttemptResolutionLedgerEntry | FixAttributionLedgerEntry

const HEAD = 'head-1'
const BASE = 'base-1'

function check(overrides: Partial<HostedReviewCheckSnapshot> = {}): HostedReviewCheckSnapshot {
  return {
    checkKey: 'test',
    checkId: 'check-1',
    name: 'test (node 20)',
    required: true,
    headSha: HEAD,
    state: 'passed',
    observationId: 'run-1:attempt-1',
    failureSignature: null,
    ...overrides
  }
}

function review(overrides: Partial<TestReview> = {}): TestReview {
  return {
    provider: 'github',
    reviewNumber: 42,
    url: 'https://github.com/acme/repo/pull/42',
    lifecycle: 'open',
    headSha: HEAD,
    baseSha: BASE,
    observedAtMs: 10_000,
    freshness: 'live',
    draft: false,
    checks: [check()],
    checksComplete: true,
    providerReadiness: { verdict: 'ready', blockers: [] },
    behindBase: false,
    conflicts: 'none',
    queue: { required: false, membership: 'not-enqueued' },
    defaultMergeMethod: 'squash',
    ...overrides
  }
}

function sitter(
  overrides: Partial<HostedReviewSitterDefinition> = {}
): HostedReviewSitterDefinition {
  return {
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    repoPath: '/repo',
    branch: 'feature',
    provider: 'github',
    reviewNumber: 42,
    reviewUrl: 'https://github.com/acme/repo/pull/42',
    capabilities: {
      updateBranch: 'on',
      resolveConflicts: 'on',
      fixChecks: 'on',
      merge: 'on'
    },
    branchUpdateMode: 'merge-base-update',
    mergeMethod: null,
    repeatFixLimit: 1,
    mergeCheckScope: 'required',
    ...overrides
  }
}

function ledger(entries: readonly TestLedgerEntry[] = []): WatcherLedger {
  return {
    watcherId: 'sitter-1',
    entries: entries.map((entry) => {
      if (entry.kind === 'attempt-resolved') {
        return {
          kind: 'attempt-resolved' as const,
          class: 'fact' as const,
          origin: 'owner' as const,
          watcherId: 'sitter-1',
          eventId: entry.eventId,
          attemptId: entry.actionId,
          atMs: entry.atMs,
          effect: entry.effect,
          evidence: entry.evidence
        }
      }
      if (entry.kind === 'fix-attribution') {
        return {
          kind: 'evidence' as const,
          class: 'fact' as const,
          origin: 'owner' as const,
          watcherId: 'sitter-1',
          eventId: entry.eventId,
          atMs: entry.atMs,
          evidenceKind: 'fix-attribution',
          payload: {
            sourceHeadSha: entry.sourceHeadSha,
            producedHeadSha: entry.producedHeadSha,
            preparedCommitSha: entry.preparedCommitSha,
            checkKey: entry.checkKey,
            failureSignature: entry.failureSignature,
            publishActionId: entry.publishActionId
          }
        }
      }
      const state =
        entry.state === 'attempted' || entry.state === 'running'
          ? entry.state
          : ('settled' as const)
      const effect =
        entry.state === 'completed'
          ? ('landed' as const)
          : (entry.effect ?? (entry.state === 'failed' ? ('indeterminate' as const) : undefined))
      return {
        kind: 'attempt' as const,
        class: 'fact' as const,
        origin: 'owner' as const,
        watcherId: 'sitter-1',
        eventId: entry.eventId,
        attemptId: entry.actionId,
        atMs: entry.atMs,
        action: entry.action,
        fingerprint: hostedReviewAttemptFingerprint(entry.action),
        state,
        ...(effect === undefined ? {} : { effect }),
        ...(entry.result === undefined ? {} : { result: entry.result }),
        ...(entry.reason === undefined ? {} : { reason: entry.reason })
      }
    })
  }
}

function evaluateRegisteredStop(
  input: TestReview,
  history: WatcherLedger,
  definition: HostedReviewSitterDefinition = sitter()
) {
  const { freshness, observedAtMs, ...reviewSnapshot } = input
  return evaluateStopPredicates(
    HOSTED_REVIEW_STOP_PREDICATES,
    {
      freshness,
      contentIdentity: hostedReviewContentIdentity(reviewSnapshot),
      observedAtMs,
      world: { review: reviewSnapshot, definition, preparedCommit: null }
    },
    history
  )
}

function completedAction(
  action: HostedReviewSitterAction,
  overrides: Partial<ActionLedgerEntry> = {}
): ActionLedgerEntry {
  const fingerprint = hostedReviewAttemptFingerprint(action)
  return {
    kind: 'action',
    eventId: `event:${fingerprint}`,
    actionId: `action:${fingerprint}`,
    atMs: 1_000,
    action,
    state: 'completed',
    result: { kind: 'none' },
    ...overrides
  }
}

describe('PR sitter fix attribution stop policy', () => {
  it('retains stop evidence without a fix-attribution row', () => {
    const snapshot = review()
    const publication: HostedReviewSitterAction = {
      kind: 'publish-fix',
      capability: 'fixChecks',
      visibility: 'external',
      contentIdentity: hostedReviewContentIdentity(snapshot),
      evidenceKey: 'prepared:test',
      expectedState: { target: snapshot.url, before: HEAD },
      headSha: HEAD,
      reviewUrl: snapshot.url,
      checkKey: 'test',
      failureSignature: 'failure:test',
      preparationActionId: 'prepare-1',
      preparedCommitSha: 'head-2'
    }
    const history = ledger([
      completedAction(publication, {
        actionId: 'publish-1',
        result: { kind: 'published', resultingHeadSha: 'head-2' }
      })
    ])
    const repeated = review({
      headSha: 'head-2',
      checks: [
        check({
          headSha: 'head-2',
          state: 'failed',
          observationId: 'head-2:test',
          failureSignature: 'failure:test'
        })
      ],
      providerReadiness: { verdict: 'blocked', blockers: ['checks'] }
    })
    expect(evaluateRegisteredStop(repeated, history)).toMatchObject({
      predicateId: 'repeated-failure-after-own-fix',
      disposition: 'park',
      reason: 'repeated-failure-after-own-fix',
      detail: 'test',
      deviation: { kind: 'check-failed', criterionId: 'test' }
    })
    expect(
      deriveHostedReviewSitterDiscrepancies(repeated, history, 'required', undefined, 1)
    ).toContainEqual(expect.objectContaining({ kind: 'fix-did-not-resolve', status: 'escalated' }))
  })

  it('recognizes repeated failures after a publish resolves as landed', () => {
    const original = review()
    const publication: HostedReviewSitterAction = {
      kind: 'publish-fix',
      capability: 'fixChecks',
      visibility: 'external',
      contentIdentity: hostedReviewContentIdentity(original),
      evidenceKey: 'prepared:resolved',
      expectedState: { target: original.url, before: HEAD },
      headSha: HEAD,
      reviewUrl: original.url,
      checkKey: 'test',
      failureSignature: 'failure:test',
      preparationActionId: 'prepare-1',
      preparedCommitSha: 'head-2'
    }
    const attempt: ActionLedgerEntry = {
      kind: 'action',
      eventId: 'publish-attempt',
      actionId: 'publish-resolved',
      atMs: 1_000,
      action: publication,
      state: 'failed',
      effect: 'indeterminate'
    }
    const history = ledger([
      attempt,
      {
        kind: 'attempt-resolved',
        eventId: 'resolution-1',
        actionId: 'publish-resolved',
        atMs: 2_000,
        effect: 'landed',
        evidence: { observedHeadSha: 'head-2' }
      }
    ])
    const repeated = review({
      headSha: 'head-2',
      checks: [
        check({
          headSha: 'head-2',
          state: 'failed',
          observationId: 'head-2:test',
          failureSignature: 'failure:test'
        })
      ],
      providerReadiness: { verdict: 'blocked', blockers: ['checks'] }
    })

    expect(evaluateRegisteredStop(repeated, history)).toMatchObject({
      predicateId: 'repeated-failure-after-own-fix',
      disposition: 'park',
      reason: 'repeated-failure-after-own-fix',
      detail: 'test',
      deviation: { kind: 'check-failed', criterionId: 'test' }
    })
    expect(
      deriveHostedReviewSitterDiscrepancies(repeated, history, 'required', undefined, 1)
    ).toContainEqual(expect.objectContaining({ kind: 'fix-did-not-resolve', status: 'escalated' }))
  })

  it('keeps stop attribution through a contiguous chain of sitter fixes', () => {
    const firstFix: FixAttributionLedgerEntry = {
      kind: 'fix-attribution',
      eventId: 'attribution-a',
      atMs: 1_000,
      sourceHeadSha: HEAD,
      producedHeadSha: 'head-2',
      preparedCommitSha: 'head-2',
      checkKey: 'test-a',
      failureSignature: 'failure:a',
      publishActionId: 'publish-a'
    }
    const secondFix: FixAttributionLedgerEntry = {
      kind: 'fix-attribution',
      eventId: 'attribution-b',
      atMs: 2_000,
      sourceHeadSha: 'head-2',
      producedHeadSha: 'head-3',
      preparedCommitSha: 'head-3',
      checkKey: 'test-b',
      failureSignature: 'failure:b',
      publishActionId: 'publish-b'
    }
    const repeatedFirstFailure = review({
      headSha: 'head-3',
      checks: [
        check({
          checkKey: 'test-a',
          headSha: 'head-3',
          state: 'failed',
          observationId: 'head-3:test-a',
          failureSignature: 'failure:a'
        })
      ],
      providerReadiness: { verdict: 'blocked', blockers: ['checks'] }
    })
    expect(
      evaluateRegisteredStop(repeatedFirstFailure, ledger([firstFix, secondFix]))
    ).toMatchObject({
      predicateId: 'repeated-failure-after-own-fix',
      disposition: 'park',
      reason: 'repeated-failure-after-own-fix',
      detail: 'test-a',
      deviation: { kind: 'check-failed', criterionId: 'test-a' }
    })
  })
})
