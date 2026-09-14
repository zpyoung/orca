import { describe, expect, it } from 'vitest'
import type { WatcherLedger } from '../fork-heimdall/ledger-types'
import {
  computeDesiredAction as computeDesiredActionCore,
  explainDesiredAction as explainDesiredActionCore
} from './decision'
import { hostedReviewAttemptFingerprint, hostedReviewContentIdentity } from './action-identity'
import { deriveHostedReviewSitterDiscrepancies } from './reconciliation'
import type {
  HostedReviewCheckSnapshot,
  HostedReviewPreparedCommit,
  HostedReviewSitterAction,
  HostedReviewSitterDefinition,
  HostedReviewSitterActionResult,
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

function computeDesiredAction(
  input: TestReview,
  definition: HostedReviewSitterDefinition,
  history: WatcherLedger,
  preparedCommit: HostedReviewPreparedCommit | null = null
) {
  const { freshness, observedAtMs: _observedAtMs, ...reviewSnapshot } = input
  return computeDesiredActionCore(reviewSnapshot, definition, history, {
    freshness,
    preparedCommit
  })
}

function explainDesiredAction(
  input: TestReview,
  definition: HostedReviewSitterDefinition,
  history: WatcherLedger
) {
  const { freshness, observedAtMs: _observedAtMs, ...reviewSnapshot } = input
  return explainDesiredActionCore(reviewSnapshot, definition, history, {
    freshness,
    preparedCommit: null
  })
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

describe('PR sitter desired-action safety policy', () => {
  it('keeps an all-off red watcher write-free', () => {
    const allOff = sitter({
      capabilities: {
        updateBranch: 'off',
        resolveConflicts: 'off',
        fixChecks: 'off',
        merge: 'off'
      }
    })
    const red = review({
      checks: [check({ state: 'failed', failureSignature: 'failure:test' })],
      providerReadiness: { verdict: 'blocked', blockers: ['checks'] }
    })
    expect(computeDesiredAction(red, allOff, ledger())).toBeNull()
  })

  it('never merges stale, cached, or incomplete green evidence', () => {
    const stale = review({ checks: [check({ headSha: 'older-head' })] })
    const cached = review({ freshness: 'cached' })
    const incomplete = review({ checks: [], checksComplete: false })

    expect(computeDesiredAction(stale, sitter(), ledger())).toBeNull()
    expect(computeDesiredAction(cached, sitter(), ledger())).toBeNull()
    expect(computeDesiredAction(incomplete, sitter(), ledger())).toBeNull()
    expect(computeDesiredAction(review(), sitter(), ledger())).toMatchObject({ kind: 'merge' })
  })

  it('uses the merge queue instead of bypassing it', () => {
    const queued = review({ queue: { required: true, membership: 'not-enqueued' } })
    expect(computeDesiredAction(queued, sitter(), ledger())).toMatchObject({ kind: 'enqueue' })
    expect(
      computeDesiredAction(
        review({ queue: { required: true, membership: 'enqueued' } }),
        sitter(),
        ledger()
      )
    ).toBeNull()
    expect(
      computeDesiredAction(
        review({ queue: { required: false, membership: 'unknown' } }),
        sitter(),
        ledger()
      )
    ).toBeNull()
  })

  it('keeps updates lazy while a reviewer gate is outstanding', () => {
    const waitingForReview = review({
      behindBase: true,
      providerReadiness: { verdict: 'blocked', blockers: ['approvals', 'behind'] }
    })
    expect(computeDesiredAction(waitingForReview, sitter(), ledger())).toBeNull()
  })

  it('preserves independent merge authority when provider allows an out-of-date head', () => {
    const mergeOnly = sitter({
      capabilities: { ...sitter().capabilities, updateBranch: 'off' }
    })
    expect(
      computeDesiredAction(
        review({ behindBase: true, providerReadiness: { verdict: 'ready', blockers: [] } }),
        mergeOnly,
        ledger()
      )
    ).toMatchObject({ kind: 'merge' })
  })

  it('updates a red branch after the base moved when check fixing is off', () => {
    const redAndBehind = review({
      behindBase: true,
      checks: [check({ state: 'failed', failureSignature: 'failure:test' })],
      providerReadiness: { verdict: 'blocked', blockers: ['approvals', 'behind', 'checks'] }
    })
    const noFix = sitter({
      capabilities: { ...sitter().capabilities, fixChecks: 'off' }
    })
    expect(computeDesiredAction(redAndBehind, noFix, ledger())).toMatchObject({
      kind: 'update-branch',
      mode: 'merge-base-update'
    })
  })

  it('resolves a ready conflict before check work, including red after a base move', () => {
    const conflicted = review({
      behindBase: true,
      conflicts: 'present',
      checks: [check({ state: 'failed', failureSignature: 'failure:test' })],
      providerReadiness: {
        verdict: 'blocked',
        blockers: ['approvals', 'behind', 'conflicts', 'checks']
      }
    })
    expect(computeDesiredAction(conflicted, sitter(), ledger())).toMatchObject({
      kind: 'prepare-conflict-resolution'
    })
  })

  it('resolves conflicts that were already present when the sitter was armed', () => {
    // conflicts usually stop CI from building a merge commit, so the checks never go green at this
    // head — a gate that waits for green here can never be satisfied.
    const conflicted = review({
      conflicts: 'present',
      checks: [check({ state: 'pending', failureSignature: null })],
      providerReadiness: { verdict: 'blocked', blockers: ['conflicts'] }
    })
    expect(computeDesiredAction(conflicted, sitter(), ledger())).toMatchObject({
      kind: 'prepare-conflict-resolution'
    })
  })

  it('resolves standing conflicts when provider readiness is unverifiable', () => {
    const conflicted = review({
      conflicts: 'present',
      checks: [check({ state: 'pending', failureSignature: null })],
      providerReadiness: { verdict: 'unknown', blockers: [] }
    })
    expect(computeDesiredAction(conflicted, sitter(), ledger())).toMatchObject({
      kind: 'prepare-conflict-resolution'
    })
  })

  it('resolves standing conflicts when the review reports no checks at all', () => {
    const conflicted = review({
      conflicts: 'present',
      checks: [],
      providerReadiness: { verdict: 'blocked', blockers: ['conflicts'] }
    })
    expect(computeDesiredAction(conflicted, sitter(), ledger())).toMatchObject({
      kind: 'prepare-conflict-resolution'
    })
  })

  it('still holds conflict resolution on a draft review', () => {
    const conflicted = review({
      draft: true,
      conflicts: 'present',
      checks: [check({ state: 'pending', failureSignature: null })],
      providerReadiness: { verdict: 'blocked', blockers: ['conflicts'] }
    })
    expect(computeDesiredAction(conflicted, sitter(), ledger())).toBeNull()
  })

  it('still prefers fixing a red check over conflicts when the base has not moved', () => {
    const conflicted = review({
      conflicts: 'present',
      behindBase: false,
      checks: [check({ state: 'failed', failureSignature: 'failure:test' })],
      providerReadiness: { verdict: 'blocked', blockers: ['conflicts', 'checks'] }
    })
    expect(computeDesiredAction(conflicted, sitter(), ledger())).toMatchObject({
      kind: 'rerun-check'
    })
  })

  it('requires one fresh rerun observation before preparing a fix', () => {
    const initial = review({
      checks: [check({ state: 'failed', failureSignature: 'failure:test' })],
      providerReadiness: { verdict: 'blocked', blockers: ['checks'] }
    })
    const rerun = computeDesiredAction(initial, sitter(), ledger())
    expect(rerun).toMatchObject({ kind: 'rerun-check' })
    if (!rerun) {
      throw new Error('expected rerun')
    }

    const afterRequest = ledger([completedAction(rerun, { result: { kind: 'rerun-requested' } })])
    expect(computeDesiredAction(initial, sitter(), afterRequest)).toBeNull()

    const reproduced = review({
      checks: [
        check({
          checkId: 'check-2',
          observationId: 'run-1:attempt-2',
          state: 'failed',
          failureSignature: 'failure:test'
        })
      ],
      providerReadiness: { verdict: 'blocked', blockers: ['checks'] }
    })
    expect(computeDesiredAction(reproduced, sitter(), afterRequest)).toMatchObject({
      kind: 'prepare-fix',
      evidence: 'fresh-rerun'
    })
  })

  it('escalates fresh reproduced failures whose signature cannot be established', () => {
    const initial = review({
      checks: [check({ state: 'failed', failureSignature: null })],
      providerReadiness: { verdict: 'blocked', blockers: ['checks'] }
    })
    const rerun = computeDesiredAction(initial, sitter(), ledger())
    if (!rerun) {
      throw new Error('expected rerun')
    }
    const history = ledger([completedAction(rerun, { result: { kind: 'rerun-requested' } })])
    const reproduced = review({
      behindBase: true,
      checks: [
        check({
          checkId: 'check-2',
          observationId: 'run-1:attempt-2',
          state: 'failed',
          failureSignature: null
        })
      ],
      providerReadiness: { verdict: 'blocked', blockers: ['behind', 'checks'] }
    })
    expect(computeDesiredAction(reproduced, sitter(), history)).toBeNull()
    expect(deriveHostedReviewSitterDiscrepancies(reproduced, history)).toContainEqual(
      expect.objectContaining({ kind: 'unverifiable-failure', status: 'escalated' })
    )
  })

  it('only bypasses the rerun for matching same-shard multi-runtime evidence', () => {
    const deterministic = review({
      checks: [
        check({
          checkId: 'node-18',
          observationId: 'node-18:1',
          state: 'failed',
          failureSignature: 'failure:widget',
          shardKey: 'shard-3',
          runtimeKey: 'node-18'
        }),
        check({
          checkId: 'node-20',
          observationId: 'node-20:1',
          state: 'failed',
          failureSignature: 'failure:widget',
          shardKey: 'shard-3',
          runtimeKey: 'node-20'
        })
      ],
      providerReadiness: { verdict: 'blocked', blockers: ['checks'] }
    })
    expect(computeDesiredAction(deterministic, sitter(), ledger())).toMatchObject({
      kind: 'prepare-fix',
      evidence: 'same-shard-multi-node'
    })

    const mismatchedShard = review({
      ...deterministic,
      checks: [deterministic.checks[0]!, { ...deterministic.checks[1]!, shardKey: 'shard-4' }]
    })
    expect(computeDesiredAction(mismatchedShard, sitter(), ledger())).toMatchObject({
      kind: 'rerun-check'
    })
  })

  it('publishes only the commit correlated to the completed preparation fingerprint', () => {
    const failing = review({
      checks: [
        check({
          checkId: 'node-18',
          observationId: 'node-18:1',
          state: 'failed',
          failureSignature: 'failure:widget',
          shardKey: 'shard-3',
          runtimeKey: 'node-18'
        }),
        check({
          checkId: 'node-20',
          observationId: 'node-20:1',
          state: 'failed',
          failureSignature: 'failure:widget',
          shardKey: 'shard-3',
          runtimeKey: 'node-20'
        })
      ],
      providerReadiness: { verdict: 'blocked', blockers: ['checks'] }
    })
    const preparation = computeDesiredAction(failing, sitter(), ledger())
    if (!preparation || preparation.kind !== 'prepare-fix') {
      throw new Error('expected a fix preparation')
    }
    const history = ledger([
      completedAction(preparation, {
        result: { kind: 'worker-dispatched', dispatchId: 'dispatch-1' }
      })
    ])
    const preparedCommit: HostedReviewPreparedCommit = {
      sourceHeadSha: preparation.headSha,
      preparedCommitSha: 'prepared-head',
      preparationAttemptFingerprint: hostedReviewAttemptFingerprint(preparation)
    }

    expect(computeDesiredAction(failing, sitter(), history, preparedCommit)).toMatchObject({
      kind: 'publish-fix',
      preparedCommitSha: 'prepared-head'
    })
    expect(
      computeDesiredAction(failing, sitter(), history, {
        ...preparedCommit,
        preparationAttemptFingerprint: 'a-different-preparation'
      })
    ).toBeNull()
  })

  it('stops on the same signature after an attributed fix across SHAs', () => {
    const fixedHead = review({
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
    const attribution: FixAttributionLedgerEntry = {
      kind: 'fix-attribution',
      eventId: 'attribution-1',
      atMs: 2_000,
      sourceHeadSha: HEAD,
      producedHeadSha: 'head-2',
      preparedCommitSha: 'head-2',
      checkKey: 'test',
      failureSignature: 'failure:test',
      publishActionId: 'publish-1'
    }
    const history = ledger([attribution])
    expect(computeDesiredAction(fixedHead, sitter(), history)).toBeNull()
    expect(deriveHostedReviewSitterDiscrepancies(fixedHead, history)).toContainEqual(
      expect.objectContaining({ kind: 'fix-did-not-resolve', status: 'escalated' })
    )

    const externalHead = review({
      ...fixedHead,
      headSha: 'head-3',
      checks: [{ ...fixedHead.checks[0]!, headSha: 'head-3', observationId: 'head-3:test' }]
    })
    expect(computeDesiredAction(externalHead, sitter(), history)).toMatchObject({
      kind: 'rerun-check'
    })
  })

  it('retains stop evidence if the process crashes before the attribution row', () => {
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
    expect(computeDesiredAction(repeated, sitter(), history)).toBeNull()
    expect(deriveHostedReviewSitterDiscrepancies(repeated, history)).toContainEqual(
      expect.objectContaining({ kind: 'fix-did-not-resolve', status: 'escalated' })
    )
  })

  it('retains stop ancestry when a fresh read alone resolves a publish as landed', () => {
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

    expect(computeDesiredAction(repeated, sitter(), history)).toBeNull()
    expect(deriveHostedReviewSitterDiscrepancies(repeated, history)).toContainEqual(
      expect.objectContaining({ kind: 'fix-did-not-resolve', status: 'escalated' })
    )
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
      computeDesiredAction(repeatedFirstFailure, sitter(), ledger([firstFix, secondFix]))
    ).toBeNull()
  })
})

describe('PR sitter no-action reasons', () => {
  it('reports a terminal review before considering actions', () => {
    expect(explainDesiredAction(review({ lifecycle: 'merged' }), sitter(), ledger())).toMatchObject(
      { action: null, reason: 'review-not-open', detail: 'merged' }
    )
  })

  it('names which merge gates are unsatisfied', () => {
    const outcome = explainDesiredAction(review({ freshness: 'cached' }), sitter(), ledger())
    expect(outcome).toMatchObject({ action: null, reason: 'merge-gates-unsatisfied' })
    expect(outcome.action).toBeNull()
    if (outcome.action === null) {
      expect(outcome.detail).toBe('freshness')
    }
  })

  it('keeps the fix-phase reason when control falls through to the merge gates', () => {
    // a red check sends us into the fix phase; an in-flight rerun makes it decline, and the
    // terminal reason then becomes the merge gates failing on those same red checks
    const red = review({
      checks: [check({ state: 'failed', failureSignature: 'failure:test' })],
      providerReadiness: { verdict: 'blocked', blockers: ['checks'] }
    })
    const snapshot = review()
    const rerunAction: HostedReviewSitterAction = {
      kind: 'rerun-check',
      capability: 'fixChecks',
      visibility: 'external',
      contentIdentity: hostedReviewContentIdentity(snapshot),
      evidenceKey: 'rerun-evidence',
      expectedState: { target: `${snapshot.url}#check:test`, before: HEAD },
      headSha: HEAD,
      reviewUrl: snapshot.url,
      checkKey: 'test',
      checkIds: ['check-1'],
      observationIds: ['run-1:attempt-1'],
      failureSignature: 'failure:test'
    }
    const inFlightRerun = ledger([
      completedAction(rerunAction, { state: 'running', result: undefined })
    ])

    const outcome = explainDesiredAction(red, sitter(), inFlightRerun)
    expect(outcome).toMatchObject({ action: null, reason: 'merge-gates-unsatisfied' })
    if (outcome.action === null) {
      expect(outcome.considered).toContainEqual(
        expect.objectContaining({ phase: 'fix-checks', reason: 'rerun-in-flight' })
      )
    }

    // with no unresolved global attempt, the fix phase itself declines and is recorded
    const settledRerun = ledger([completedAction(rerunAction)])
    const fellThrough = explainDesiredAction(red, sitter(), settledRerun)
    expect(fellThrough.action).toBeNull()
    if (fellThrough.action === null) {
      expect(fellThrough.reason).toBe('merge-gates-unsatisfied')
      expect(fellThrough.considered).toContainEqual(
        expect.objectContaining({ phase: 'fix-checks' })
      )
    }
  })

  it('records a disabled capability as a considered phase, not a terminal reason', () => {
    const red = review({
      checks: [check({ state: 'failed', failureSignature: 'failure:test' })],
      providerReadiness: { verdict: 'blocked', blockers: ['checks'] }
    })
    const outcome = explainDesiredAction(
      red,
      sitter({
        capabilities: {
          updateBranch: 'on',
          resolveConflicts: 'on',
          fixChecks: 'off',
          merge: 'on'
        }
      }),
      ledger()
    )
    expect(outcome.action).toBeNull()
    if (outcome.action === null) {
      expect(outcome.considered).toContainEqual({
        phase: 'fix-checks',
        reason: 'capability-off',
        detail: 'fixChecks'
      })
    }
  })

  it('keeps computeDesiredAction in lockstep with explainDesiredAction', () => {
    const cases: [TestReview, HostedReviewSitterDefinition][] = [
      [review(), sitter()],
      [review({ freshness: 'cached' }), sitter()],
      [review({ behindBase: true }), sitter()],
      [review({ conflicts: 'present' }), sitter()],
      [review({ lifecycle: 'closed' }), sitter()]
    ]
    for (const [snapshot, definition] of cases) {
      expect(computeDesiredAction(snapshot, definition, ledger())).toEqual(
        explainDesiredAction(snapshot, definition, ledger()).action
      )
    }
  })
})
