import { describe, expect, it } from 'vitest'
import type { WatcherLedger } from '../fork-heimdall/ledger-types'
import { hostedReviewAttemptFingerprint } from './action-identity'
import {
  buildMergeAction,
  buildPrepareConflictAction,
  buildPrepareFixAction,
  buildPublishFixAction,
  buildRerunAction,
  buildUpdateAction
} from './decision-action-builders'
import { failedCheckGroups } from './decision-check-groups'
import { explainDesiredAction } from './decision'
import type {
  HostedReviewAttemptEntry,
  HostedReviewCheckSnapshot,
  HostedReviewPreparedCommit,
  HostedReviewSitterAction,
  HostedReviewSitterDefinition,
  HostedReviewSnapshot
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
    capabilities: { updateBranch: 'on', resolveConflicts: 'on', fixChecks: 'on', merge: 'on' },
    branchUpdateMode: 'merge-base-update',
    mergeMethod: null,
    ...overrides
  }
}

function attempt(
  action: HostedReviewSitterAction,
  state: 'attempted' | 'settled',
  effect?: 'landed',
  dispatchId?: string
): HostedReviewAttemptEntry {
  return {
    kind: 'attempt',
    class: 'fact',
    origin: 'owner',
    watcherId: WATCHER_ID,
    eventId: `event:${action.evidenceKey}`,
    attemptId: `attempt:${action.evidenceKey}`,
    atMs: 1_000,
    action,
    fingerprint: hostedReviewAttemptFingerprint(action),
    state,
    ...(effect === undefined ? {} : { effect }),
    ...(dispatchId === undefined ? {} : { dispatchId })
  }
}

/** Settled without a matching `attempt-resolved`: `getAttemptDisposition` reports it `unresolved`. */
function unresolvedAttempt(
  action: HostedReviewSitterAction,
  dispatchId?: string
): HostedReviewAttemptEntry {
  return attempt(action, 'settled', undefined, dispatchId)
}

function completedAttempt(
  action: HostedReviewSitterAction,
  dispatchId?: string
): HostedReviewAttemptEntry {
  return attempt(action, 'settled', 'landed', dispatchId)
}

function ledger(entries: readonly HostedReviewAttemptEntry[] = []): WatcherLedger {
  return { watcherId: WATCHER_ID, entries }
}

function decide(
  input: HostedReviewSnapshot,
  definition: HostedReviewSitterDefinition,
  history: WatcherLedger,
  preparedCommit: HostedReviewPreparedCommit | null = null
) {
  return explainDesiredAction(input, definition, history, { freshness: 'live', preparedCommit })
}

function deterministicRedReview(
  overrides: Partial<HostedReviewSnapshot> = {}
): HostedReviewSnapshot {
  return review({
    checks: [
      check({ shardKey: 'shard-a', runtimeKey: 'node-20' }),
      check({ shardKey: 'shard-a', runtimeKey: 'node-22', observationId: 'run-1:attempt-2' })
    ],
    ...overrides
  })
}

describe('hosted review sitter owner deviations', () => {
  it('deviates when a check rerun never settles', () => {
    const red = review({ checks: [check()] })
    const group = failedCheckGroups(red)[0]!
    const rerun = buildRerunAction(red, group)
    const outcome = decide(red, sitter(), ledger([unresolvedAttempt(rerun)]))
    expect(outcome).toMatchObject({
      action: null,
      deviation: { kind: 'landing-failed', rung: 'rerun-check', contentIdentity: HEAD }
    })
  })

  it('keeps an in-flight rerun a plain decline, not a deviation', () => {
    const red = review({ checks: [check()] })
    const group = failedCheckGroups(red)[0]!
    const rerun = buildRerunAction(red, group)
    const outcome = decide(red, sitter(), ledger([attempt(rerun, 'attempted')]))
    expect(outcome).toMatchObject({ action: null, reason: 'merge-gates-unsatisfied' })
    expect('deviation' in outcome).toBe(false)
    if ('considered' in outcome) {
      expect(outcome.considered).toContainEqual(
        expect.objectContaining({ phase: 'fix-checks', reason: 'rerun-in-flight' })
      )
    }
  })

  it('does not re-deviate a stuck update-branch while an owner retry is already in flight', () => {
    // 'blocked' on only the 'behind' blocker still lets update-branch proceed but, unlike
    // 'ready', keeps the later merge gate unsatisfied so the fallthrough doesn't race to a merge
    const behind = review({
      behindBase: true,
      providerReadiness: { verdict: 'blocked', blockers: ['behind'] }
    })
    const stuck = buildUpdateAction(behind, sitter())
    const retry = { ...stuck, evidenceKey: `${stuck.evidenceKey}:owner-retry` }
    const outcome = decide(
      behind,
      sitter(),
      ledger([unresolvedAttempt(stuck), attempt(retry, 'attempted')])
    )
    expect('deviation' in outcome).toBe(false)
    if ('considered' in outcome) {
      expect(outcome.considered).toContainEqual(
        expect.objectContaining({ phase: 'update-branch', reason: 'owner-retry-in-flight' })
      )
    }
  })

  it('reports a worker-unverifiable deviation for a prepare-fix that never resolves', () => {
    const red = deterministicRedReview()
    const group = failedCheckGroups(red)[0]!
    const preparation = buildPrepareFixAction(
      red,
      group.checkKey,
      group.checks,
      'same-shard-multi-node'
    )!
    const outcome = decide(red, sitter(), ledger([unresolvedAttempt(preparation, 'dispatch-1')]))
    expect(outcome).toMatchObject({
      action: null,
      deviation: { kind: 'worker-unverifiable', dispatchId: 'dispatch-1' }
    })
  })

  it('reports a worker-unverifiable deviation when a completed fix leaves no usable prepared commit', () => {
    const red = deterministicRedReview()
    const group = failedCheckGroups(red)[0]!
    const preparation = buildPrepareFixAction(
      red,
      group.checkKey,
      group.checks,
      'same-shard-multi-node'
    )!
    const outcome = decide(red, sitter(), ledger([completedAttempt(preparation, 'dispatch-2')]))
    expect(outcome).toMatchObject({
      action: null,
      deviation: { kind: 'worker-unverifiable', dispatchId: 'dispatch-2' }
    })
  })

  it('deviates when publishing a fix never settles', () => {
    const red = deterministicRedReview()
    const group = failedCheckGroups(red)[0]!
    const preparation = buildPrepareFixAction(
      red,
      group.checkKey,
      group.checks,
      'same-shard-multi-node'
    )!
    const completedEntry = completedAttempt(preparation)
    const preparedCommit: HostedReviewPreparedCommit = {
      sourceHeadSha: HEAD,
      preparedCommitSha: 'commit-1',
      preparationAttemptFingerprint: hostedReviewAttemptFingerprint(preparation)
    }
    const publication = buildPublishFixAction(preparation, completedEntry, preparedCommit)!
    const outcome = decide(
      red,
      sitter(),
      ledger([completedEntry, unresolvedAttempt(publication)]),
      preparedCommit
    )
    expect(outcome).toMatchObject({
      action: null,
      deviation: { kind: 'landing-failed', rung: 'publish-fix', contentIdentity: HEAD }
    })
  })

  it('deviates when a conflict-resolution preparation never resolves', () => {
    const conflicted = review({ conflicts: 'present' })
    const preparation = buildPrepareConflictAction(conflicted)
    const outcome = decide(
      conflicted,
      sitter(),
      ledger([unresolvedAttempt(preparation, 'dispatch-3')])
    )
    expect(outcome).toMatchObject({
      action: null,
      deviation: { kind: 'worker-unverifiable', dispatchId: 'dispatch-3' }
    })
  })

  it('deviates when a branch update never settles', () => {
    const behind = review({
      behindBase: true,
      providerReadiness: { verdict: 'ready', blockers: [] }
    })
    const action = buildUpdateAction(behind, sitter())
    const outcome = decide(behind, sitter(), ledger([unresolvedAttempt(action)]))
    expect(outcome).toMatchObject({
      action: null,
      deviation: { kind: 'landing-failed', rung: 'update-branch', contentIdentity: HEAD }
    })
  })

  it('deviates when a merge attempt never settles', () => {
    const ready = review()
    const action = buildMergeAction(ready, sitter())!
    const outcome = decide(ready, sitter(), ledger([unresolvedAttempt(action)]))
    expect(outcome).toMatchObject({
      action: null,
      deviation: { kind: 'landing-failed', rung: 'merge', contentIdentity: HEAD }
    })
  })

  it('deviates when the provider ejects the review from its merge queue', () => {
    const ejected = review({ queue: { required: true, membership: 'ejected' } })
    const outcome = decide(ejected, sitter(), ledger())
    expect(outcome).toMatchObject({
      action: null,
      deviation: { kind: 'landing-failed', rung: 'enqueue', contentIdentity: HEAD }
    })
  })
})
