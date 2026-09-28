import { describe, expect, it } from 'vitest'
import type { WatcherLedger } from '../fork-heimdall/ledger-types'
import { evaluateStopPredicates } from '../fork-heimdall/stop-policy'
import { HOSTED_REVIEW_STOP_PREDICATES } from './stop-policy'
import type {
  HostedReviewCheckSnapshot,
  HostedReviewSitterDefinition,
  HostedReviewSnapshot,
  HostedReviewWorld
} from './types'

const HEAD = 'head-1'
const BASE = 'base-1'
const WATCHER_ID = 'sitter-1'

function check(overrides: Partial<HostedReviewCheckSnapshot> = {}): HostedReviewCheckSnapshot {
  return {
    checkKey: 'test',
    checkId: 'check-1',
    name: 'test (node 20)',
    required: true,
    headSha: HEAD,
    state: 'failed',
    observationId: 'run-1:attempt-1',
    failureSignature: 'failure:test',
    ...overrides
  }
}

function review(overrides: Partial<HostedReviewSnapshot> = {}): HostedReviewSnapshot {
  return {
    provider: 'github',
    reviewNumber: 42,
    url: 'https://github.com/acme/repo/pull/42',
    lifecycle: 'open',
    headSha: HEAD,
    baseSha: BASE,
    draft: false,
    checks: [],
    checksComplete: true,
    providerReadiness: { verdict: 'ready', blockers: [] },
    behindBase: false,
    conflicts: 'none',
    queue: { required: false, membership: 'not-enqueued' },
    defaultMergeMethod: 'squash',
    ...overrides
  }
}

function definition(): HostedReviewSitterDefinition {
  return {
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    repoPath: '/repo',
    branch: 'feature',
    provider: 'github',
    reviewNumber: 42,
    reviewUrl: 'https://github.com/acme/repo/pull/42',
    capabilities: { updateBranch: 'on', resolveConflicts: 'on', fixChecks: 'on', merge: 'on' },
    branchUpdateMode: 'merge-base-update',
    mergeMethod: null
  }
}

function snapshot(world: HostedReviewWorld) {
  return { freshness: 'live' as const, contentIdentity: 'content-1', observedAtMs: 0, world }
}

function fixAttributionEntry(): WatcherLedger['entries'][number] {
  return {
    kind: 'evidence',
    class: 'fact',
    origin: 'owner',
    watcherId: WATCHER_ID,
    eventId: 'event:fix-attribution',
    atMs: 1_000,
    evidenceKind: 'fix-attribution',
    payload: {
      sourceHeadSha: 'prior-head',
      producedHeadSha: HEAD,
      preparedCommitSha: HEAD,
      checkKey: 'test',
      failureSignature: 'failure:test',
      publishActionId: 'publish-1'
    }
  }
}

function completedRerunEntry(observationIds: readonly string[]): WatcherLedger['entries'][number] {
  const action = {
    kind: 'rerun-check' as const,
    capability: 'fixChecks',
    visibility: 'external' as const,
    contentIdentity: `["${HEAD}","${BASE}"]`,
    evidenceKey: 'rerun-1',
    expectedState: { target: 'https://github.com/acme/repo/pull/42#check:test', before: HEAD },
    headSha: HEAD,
    reviewUrl: 'https://github.com/acme/repo/pull/42',
    checkKey: 'test',
    checkIds: ['check-1'],
    observationIds,
    failureSignature: 'failure:test'
  }
  return {
    kind: 'attempt',
    class: 'fact',
    origin: 'owner',
    watcherId: WATCHER_ID,
    eventId: 'event:rerun-1',
    attemptId: 'attempt:rerun-1',
    atMs: 1_000,
    action,
    fingerprint: JSON.stringify([action.contentIdentity, action.kind, action.evidenceKey]),
    state: 'settled',
    effect: 'landed'
  }
}

function ledger(entries: readonly WatcherLedger['entries'][number][]): WatcherLedger {
  return { watcherId: WATCHER_ID, entries }
}

describe('hosted review sitter stop predicates opt into owner deviations', () => {
  it('reports a check-failed deviation when the sitter own-fix did not resolve the failure', () => {
    const world: HostedReviewWorld = {
      review: review({ checks: [check()] }),
      definition: definition(),
      preparedCommit: null
    }
    const fired = evaluateStopPredicates(
      HOSTED_REVIEW_STOP_PREDICATES,
      snapshot(world),
      ledger([fixAttributionEntry()])
    )
    expect(fired).toMatchObject({
      predicateId: 'repeated-failure-after-own-fix',
      deviation: { kind: 'check-failed', criterionId: 'test', timedOut: null }
    })
  })

  it('reports a check-failed deviation when a rerun reproduces an unclassifiable failure', () => {
    const world: HostedReviewWorld = {
      review: review({
        checks: [check({ observationId: 'run-2:attempt-1', failureSignature: null })]
      }),
      definition: definition(),
      preparedCommit: null
    }
    const fired = evaluateStopPredicates(
      HOSTED_REVIEW_STOP_PREDICATES,
      snapshot(world),
      ledger([completedRerunEntry(['run-1:attempt-1'])])
    )
    expect(fired).toMatchObject({
      predicateId: 'unverifiable-reproduced-failure',
      deviation: { kind: 'check-failed', criterionId: 'test', timedOut: null }
    })
  })

  it('still parks a closed review with no deviation, since that predicate opts out', () => {
    const world: HostedReviewWorld = {
      review: review({ lifecycle: 'merged' }),
      definition: definition(),
      preparedCommit: null
    }
    const fired = evaluateStopPredicates(HOSTED_REVIEW_STOP_PREDICATES, snapshot(world), ledger([]))
    expect(fired).toMatchObject({ predicateId: 'hosted-review-lifecycle-closed' })
    expect(fired?.deviation).toBeUndefined()
  })
})
