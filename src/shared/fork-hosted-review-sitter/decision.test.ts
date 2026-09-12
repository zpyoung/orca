import { describe, expect, it } from 'vitest'
import { computeDesiredAction } from './decision'
import { deriveHostedReviewSitterDiscrepancies } from './reconciliation'
import type {
  ActionLedgerEntry,
  FixAttributionLedgerEntry,
  HostedReviewCheckSnapshot,
  HostedReviewSitterDefinition,
  HostedReviewSitterAction,
  HostedReviewSitterLedger,
  HostedReviewSnapshot
} from './types'

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

function review(overrides: Partial<HostedReviewSnapshot> = {}): HostedReviewSnapshot {
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
    id: 'sitter-1',
    enabled: true,
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
    activeBudgetMs: 4 * 60 * 60_000,
    branchUpdateMode: 'merge-base-update',
    mergeMethod: null,
    ...overrides
  }
}

function ledger(entries: HostedReviewSitterLedger['entries'] = []): HostedReviewSitterLedger {
  return { sitterId: 'sitter-1', entries }
}

function completedAction(
  action: HostedReviewSitterAction,
  overrides: Partial<ActionLedgerEntry> = {}
): ActionLedgerEntry {
  return {
    kind: 'action',
    eventId: `event:${action.key}`,
    actionId: `action:${action.key}`,
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
    const publication: HostedReviewSitterAction = {
      kind: 'publish-fix',
      capability: 'fixChecks',
      key: 'publish-fix:head-1:test',
      evidenceKey: 'prepared:test',
      headSha: HEAD,
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

  it('counts only checkpointed active time against the budget', () => {
    const budgeted = sitter({ activeBudgetMs: 1_000 })
    const history = ledger([
      {
        kind: 'active-time',
        eventId: 'active-1',
        atMs: 500,
        activeMs: 600,
        source: 'tick'
      },
      {
        kind: 'active-time',
        eventId: 'active-2',
        atMs: 50_000,
        activeMs: 400,
        source: 'tick'
      }
    ])
    expect(computeDesiredAction(review({ observedAtMs: 1_000_000 }), budgeted, history)).toBeNull()
  })
})
