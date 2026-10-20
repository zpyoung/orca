import { describe, expect, it } from 'vitest'
import type { WatcherLedger } from '../fork-heimdall/ledger-types'
import { evaluateStopPredicates } from '../fork-heimdall/stop-policy'
import { hostedReviewAttemptFingerprint } from './action-identity'
import {
  HOSTED_REVIEW_STOP_PREDICATES,
  repeatedOwnFixExhausted,
  repeatedOwnFixGroups
} from './stop-policy'
import type {
  HostedReviewCheckSnapshot,
  HostedReviewSitterAction,
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

function definition(
  mergeCheckScope: 'required' | 'all' = 'required',
  repeatFixLimit?: number
): HostedReviewSitterDefinition {
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
    mergeMethod: null,
    mergeCheckScope,
    ...(repeatFixLimit === undefined ? {} : { repeatFixLimit })
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

function completedPublishFixEntry(
  attemptId: string,
  sourceHeadSha: string,
  producedHeadSha: string,
  atMs: number,
  checkKey = 'test',
  failureSignature = 'failure:test'
): WatcherLedger['entries'][number] {
  const action: HostedReviewSitterAction = {
    kind: 'publish-fix',
    capability: 'fixChecks',
    visibility: 'external',
    contentIdentity: JSON.stringify([sourceHeadSha, BASE]),
    evidenceKey: `publish-fix:${attemptId}`,
    expectedState: {
      target: 'https://github.com/acme/repo/pull/42',
      before: sourceHeadSha
    },
    headSha: sourceHeadSha,
    reviewUrl: 'https://github.com/acme/repo/pull/42',
    checkKey,
    failureSignature,
    preparationActionId: `prepare:${attemptId}`,
    preparedCommitSha: producedHeadSha
  }
  return {
    kind: 'attempt',
    class: 'fact',
    origin: 'owner',
    watcherId: WATCHER_ID,
    eventId: `event:${attemptId}`,
    attemptId,
    atMs,
    action,
    fingerprint: hostedReviewAttemptFingerprint(action),
    state: 'settled',
    effect: 'landed',
    result: { kind: 'published', resultingHeadSha: producedHeadSha }
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
      definition: definition('required', 1),
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

  it('counts only completed publish fixes in the same check and signature group', () => {
    const first = completedPublishFixEntry('publish-1', 'head-1', 'head-2', 1_000)
    const second = completedPublishFixEntry('publish-2', 'head-2', 'head-3', 2_000)
    const third = completedPublishFixEntry('publish-3', 'head-3', 'head-4', 3_000)
    const reviewAfterTwo = review({
      headSha: 'head-3',
      checks: [check({ headSha: 'head-3', observationId: 'head-3:attempt' })]
    })
    const reviewAfterThree = review({
      headSha: 'head-4',
      checks: [check({ headSha: 'head-4', observationId: 'head-4:attempt' })]
    })
    const twoAttempts = repeatedOwnFixGroups(reviewAfterTwo, ledger([first, second]), 'required')
    const threeAttempts = repeatedOwnFixGroups(
      reviewAfterThree,
      ledger([first, second, third]),
      'required'
    )

    expect(twoAttempts).toEqual([
      {
        checkKey: 'test',
        failureSignature: 'failure:test',
        publishActionIds: ['publish-1', 'publish-2']
      }
    ])
    expect(repeatedOwnFixExhausted(twoAttempts, 3)).toBeNull()
    expect(repeatedOwnFixExhausted(threeAttempts, 3)).toEqual({
      checkKey: 'test',
      failureSignature: 'failure:test',
      publishActionIds: ['publish-1', 'publish-2', 'publish-3']
    })

    const otherGroupAttempts = [
      completedPublishFixEntry('publish-a1', 'head-1', 'head-2', 1_000),
      completedPublishFixEntry('publish-b1', 'head-2', 'head-3', 2_000, 'other', 'failure:other'),
      completedPublishFixEntry('publish-a2', 'head-3', 'head-4', 3_000),
      completedPublishFixEntry('publish-b2', 'head-4', 'head-5', 4_000, 'other', 'failure:other')
    ]
    const twoCurrentFailures = review({
      headSha: 'head-5',
      checks: [
        check({ checkKey: 'test', headSha: 'head-5', observationId: 'head-5:test' }),
        check({
          checkKey: 'other',
          headSha: 'head-5',
          observationId: 'head-5:other',
          failureSignature: 'failure:other'
        })
      ]
    })
    const separateGroups = repeatedOwnFixGroups(
      twoCurrentFailures,
      ledger(otherGroupAttempts),
      'required'
    )
    expect(separateGroups).toEqual([
      {
        checkKey: 'other',
        failureSignature: 'failure:other',
        publishActionIds: ['publish-b1', 'publish-b2']
      },
      {
        checkKey: 'test',
        failureSignature: 'failure:test',
        publishActionIds: ['publish-a1', 'publish-a2']
      }
    ])
    expect(repeatedOwnFixExhausted(separateGroups, 3)).toBeNull()
  })

  it('parks and reconciles only at the configured repeated-failure threshold', () => {
    const first = completedPublishFixEntry('publish-1', 'head-1', 'head-2', 1_000)
    const second = completedPublishFixEntry('publish-2', 'head-2', 'head-3', 2_000)
    const third = completedPublishFixEntry('publish-3', 'head-3', 'head-4', 3_000)
    const threshold = definition('required', 3)
    const atSecondHead: HostedReviewWorld = {
      review: review({
        headSha: 'head-2',
        checks: [check({ headSha: 'head-2', observationId: 'head-2:attempt' })]
      }),
      definition: threshold,
      preparedCommit: null
    }
    const atThirdHead: HostedReviewWorld = {
      ...atSecondHead,
      review: review({
        headSha: 'head-3',
        checks: [check({ headSha: 'head-3', observationId: 'head-3:attempt' })]
      })
    }
    const atFourthHead: HostedReviewWorld = {
      ...atSecondHead,
      review: review({
        headSha: 'head-4',
        checks: [check({ headSha: 'head-4', observationId: 'head-4:attempt' })]
      })
    }
    const oneFailure = ledger([first])
    const twoFailures = ledger([first, second])
    const threeFailures = ledger([first, second, third])

    expect(
      evaluateStopPredicates(HOSTED_REVIEW_STOP_PREDICATES, snapshot(atSecondHead), oneFailure)
    ).toBeNull()
    expect(
      evaluateStopPredicates(HOSTED_REVIEW_STOP_PREDICATES, snapshot(atThirdHead), twoFailures)
    ).toBeNull()
    expect(
      evaluateStopPredicates(HOSTED_REVIEW_STOP_PREDICATES, snapshot(atFourthHead), threeFailures)
    ).toMatchObject({
      predicateId: 'repeated-failure-after-own-fix',
      reason: 'repeated-failure-after-own-fix'
    })

    const legacyThresholdBeforeLimit: HostedReviewWorld = {
      ...atThirdHead,
      definition: definition()
    }
    expect(
      evaluateStopPredicates(
        HOSTED_REVIEW_STOP_PREDICATES,
        snapshot(legacyThresholdBeforeLimit),
        twoFailures
      )
    ).toBeNull()

    const legacyThresholdWorld: HostedReviewWorld = {
      ...atFourthHead,
      definition: definition()
    }
    expect(
      evaluateStopPredicates(
        HOSTED_REVIEW_STOP_PREDICATES,
        snapshot(legacyThresholdWorld),
        threeFailures
      )
    ).toMatchObject({ reason: 'repeated-failure-after-own-fix' })

    const changedSignature: HostedReviewWorld = {
      ...atFourthHead,
      review: review({
        headSha: 'head-4',
        checks: [
          check({
            headSha: 'head-4',
            observationId: 'head-4:changed',
            failureSignature: 'failure:changed'
          })
        ]
      })
    }
    expect(
      evaluateStopPredicates(
        HOSTED_REVIEW_STOP_PREDICATES,
        snapshot(changedSignature),
        threeFailures
      )
    ).toBeNull()
  })
  it('paces repeated optional failures only when all checks are in scope', () => {
    const optionalFailure = check({ required: false })
    const allScopeWorld: HostedReviewWorld = {
      review: review({ checks: [optionalFailure] }),
      definition: definition('all', 1),
      preparedCommit: null
    }
    const requiredScopeWorld: HostedReviewWorld = {
      ...allScopeWorld,
      definition: definition('required', 1)
    }
    const history = ledger([fixAttributionEntry()])

    expect(
      evaluateStopPredicates(HOSTED_REVIEW_STOP_PREDICATES, snapshot(allScopeWorld), history)
    ).toMatchObject({ predicateId: 'repeated-failure-after-own-fix' })
    expect(
      evaluateStopPredicates(HOSTED_REVIEW_STOP_PREDICATES, snapshot(requiredScopeWorld), history)
    ).toBeNull()
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
  it('tracks unclassifiable optional failures after rerun in all scope', () => {
    const world: HostedReviewWorld = {
      review: review({
        checks: [
          check({
            required: false,
            observationId: 'run-2:attempt-1',
            failureSignature: null
          })
        ]
      }),
      definition: definition('all'),
      preparedCommit: null
    }
    const fired = evaluateStopPredicates(
      HOSTED_REVIEW_STOP_PREDICATES,
      snapshot(world),
      ledger([completedRerunEntry(['run-1:attempt-1'])])
    )

    expect(fired).toMatchObject({
      predicateId: 'unverifiable-reproduced-failure',
      deviation: { kind: 'check-failed', criterionId: 'test' }
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
