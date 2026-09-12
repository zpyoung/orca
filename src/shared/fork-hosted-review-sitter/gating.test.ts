import { describe, expect, it } from 'vitest'
import { computeDesiredAction } from './decision'
import { gateDesiredAction } from './gating'
import { approvalScopeForAction } from './ledger'
import {
  deriveActionApprovalDiscrepancy,
  deriveHostedReviewSitterDiscrepancies
} from './reconciliation'
import type {
  ActionLedgerEntry,
  HostedReviewSitterAction,
  HostedReviewSitterDefinition,
  HostedReviewSitterLedger,
  HostedReviewSnapshot
} from './types'

function review(overrides: Partial<HostedReviewSnapshot> = {}): HostedReviewSnapshot {
  return {
    provider: 'github',
    reviewNumber: 42,
    url: 'https://github.com/acme/repo/pull/42',
    lifecycle: 'open',
    headSha: 'head-1',
    baseSha: 'base-1',
    observedAtMs: 5_000,
    freshness: 'live',
    draft: false,
    checks: [
      {
        checkKey: 'test',
        checkId: 'check-1',
        name: 'test',
        required: true,
        headSha: 'head-1',
        state: 'passed',
        observationId: 'test:1',
        failureSignature: null
      }
    ],
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
    activeBudgetMs: 10_000,
    branchUpdateMode: 'merge-base-update',
    mergeMethod: null,
    ...overrides
  }
}

function ledger(entries: HostedReviewSitterLedger['entries'] = []): HostedReviewSitterLedger {
  return { sitterId: 'sitter-1', entries }
}

function actionEntry(
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

function reproducedFix() {
  const failed = review({
    checks: [
      {
        ...review().checks[0]!,
        state: 'failed',
        failureSignature: 'failure:test'
      }
    ],
    providerReadiness: { verdict: 'blocked', blockers: ['checks'] }
  })
  const initialLedger = ledger()
  const rerun = computeDesiredAction(failed, sitter(), initialLedger)
  if (!rerun || rerun.kind !== 'rerun-check') {
    throw new Error('expected rerun')
  }
  const rerunEntry = actionEntry(rerun, { result: { kind: 'rerun-requested' } })
  const reproduced = review({
    ...failed,
    checks: [
      {
        ...failed.checks[0]!,
        checkId: 'check-2',
        observationId: 'test:2'
      }
    ]
  })
  const rerunLedger = ledger([rerunEntry])
  const preparation = computeDesiredAction(reproduced, sitter(), rerunLedger)
  if (!preparation || preparation.kind !== 'prepare-fix') {
    throw new Error('expected fix preparation')
  }
  return { reproduced, rerunEntry, preparation }
}

describe('PR sitter action gates', () => {
  it('allows gated fix preparation but requires exact prepared-commit approval to publish', () => {
    const { reproduced, rerunEntry, preparation } = reproducedFix()
    const gated = sitter({
      capabilities: { ...sitter().capabilities, fixChecks: 'gated' }
    })
    expect(
      gateDesiredAction(preparation, reproduced, gated, ledger([rerunEntry]), {
        state: 'clear'
      })
    ).toEqual({ verdict: 'allow' })

    const preparationEntry = actionEntry(preparation, {
      actionId: 'prepare-1',
      atMs: 2_000,
      result: { kind: 'prepared', preparedCommitSha: 'prepared-1' }
    })
    const preparedLedger = ledger([rerunEntry, preparationEntry])
    const publication = computeDesiredAction(reproduced, gated, preparedLedger)
    expect(publication).toMatchObject({
      kind: 'publish-fix',
      preparedCommitSha: 'prepared-1'
    })
    if (!publication) {
      throw new Error('expected publication')
    }

    expect(
      gateDesiredAction(publication, reproduced, gated, preparedLedger, { state: 'clear' })
    ).toEqual({ verdict: 'hold', reason: 'awaiting-approval' })

    const scope = approvalScopeForAction(publication)
    const wrongApproval = ledger([
      rerunEntry,
      preparationEntry,
      {
        kind: 'approval',
        eventId: 'approval-wrong',
        atMs: 3_000,
        scope: { ...scope, preparedCommitSha: 'different-commit' },
        decision: 'approved'
      }
    ])
    expect(
      gateDesiredAction(publication, reproduced, gated, wrongApproval, { state: 'clear' })
    ).toEqual({ verdict: 'hold', reason: 'awaiting-approval' })

    const approved = ledger([
      rerunEntry,
      preparationEntry,
      {
        kind: 'approval',
        eventId: 'approval-exact',
        atMs: 4_000,
        scope,
        decision: 'approved'
      }
    ])
    expect(gateDesiredAction(publication, reproduced, gated, approved, { state: 'clear' })).toEqual(
      { verdict: 'allow' }
    )
  })

  it('derives an approval discrepancy with the exact action scope', () => {
    const gated = sitter({
      capabilities: { ...sitter().capabilities, merge: 'gated' }
    })
    const merge = computeDesiredAction(review(), gated, ledger())
    if (!merge) {
      throw new Error('expected merge')
    }
    const discrepancy = deriveActionApprovalDiscrepancy(merge, ledger())
    expect(discrepancy).toMatchObject({
      kind: 'awaiting-approval',
      status: 'open',
      approvalScope: approvalScopeForAction(merge)
    })
  })

  it('invalidates gated merge approval when same-head check evidence changes', () => {
    const gated = sitter({
      capabilities: { ...sitter().capabilities, merge: 'gated' }
    })
    const initial = review()
    const merge = computeDesiredAction(initial, gated, ledger())
    if (!merge) {
      throw new Error('expected merge')
    }
    const approved = ledger([
      {
        kind: 'approval',
        eventId: 'approval-1',
        atMs: 2_000,
        scope: approvalScopeForAction(merge),
        decision: 'approved'
      }
    ])
    const newerGreen = review({
      checks: [{ ...initial.checks[0]!, observationId: 'test:2' }]
    })
    expect(gateDesiredAction(merge, newerGreen, gated, approved, { state: 'clear' })).toEqual({
      verdict: 'hold',
      reason: 'stale-evidence'
    })
  })

  it('surfaces unverifiable contention and never lets approval bypass it', () => {
    const gated = sitter({
      capabilities: { ...sitter().capabilities, merge: 'gated' }
    })
    const merge = computeDesiredAction(review(), gated, ledger())
    if (!merge) {
      throw new Error('expected merge')
    }
    const approved = ledger([
      {
        kind: 'approval',
        eventId: 'approval-1',
        atMs: 2_000,
        scope: approvalScopeForAction(merge),
        decision: 'approved'
      }
    ])
    expect(
      gateDesiredAction(merge, review(), gated, approved, {
        state: 'unverifiable',
        reason: 'host-offline'
      })
    ).toEqual({ verdict: 'hold', reason: 'contention-unverifiable' })
  })

  it('escalates rather than replaying an action with an ambiguous outcome', () => {
    const behind = review({
      behindBase: true,
      providerReadiness: { verdict: 'blocked', blockers: ['behind'] }
    })
    const update = computeDesiredAction(behind, sitter(), ledger())
    if (!update) {
      throw new Error('expected update')
    }
    const ambiguous = ledger([
      actionEntry(update, {
        state: 'failed',
        effect: 'unknown',
        result: undefined,
        reason: 'connection-lost-after-request'
      })
    ])
    expect(gateDesiredAction(update, behind, sitter(), ambiguous, { state: 'clear' })).toEqual({
      verdict: 'escalate',
      reason: 'ambiguous-action'
    })
    expect(deriveHostedReviewSitterDiscrepancies(behind, ambiguous)).toContainEqual(
      expect.objectContaining({ kind: 'ambiguous-action', status: 'escalated' })
    )

    const advanced = review({
      headSha: 'head-2',
      checks: [
        {
          ...review().checks[0]!,
          headSha: 'head-2',
          observationId: 'test:head-2'
        }
      ]
    })
    expect(computeDesiredAction(advanced, sitter(), ambiguous)).toBeNull()
    const candidate = computeDesiredAction(advanced, sitter(), ledger())
    if (!candidate) {
      throw new Error('expected merge candidate')
    }
    expect(gateDesiredAction(candidate, advanced, sitter(), ambiguous, { state: 'clear' })).toEqual(
      { verdict: 'escalate', reason: 'ambiguous-action' }
    )
  })

  it('treats a recovered unowned running attempt as ambiguous', () => {
    const behind = review({
      behindBase: true,
      providerReadiness: { verdict: 'blocked', blockers: ['behind'] }
    })
    const update = computeDesiredAction(behind, sitter(), ledger())
    if (!update) {
      throw new Error('expected update')
    }
    const attempted = ledger([actionEntry(update, { state: 'attempted', result: undefined })])
    expect(
      deriveHostedReviewSitterDiscrepancies(behind, attempted, { state: 'clear' })
    ).toContainEqual(expect.objectContaining({ kind: 'ambiguous-action', status: 'escalated' }))
  })

  it('prepares a gated conflict but escalates when conflict authority is off', () => {
    const conflicted = review({
      behindBase: true,
      conflicts: 'present',
      providerReadiness: { verdict: 'blocked', blockers: ['behind', 'conflicts'] }
    })
    const gated = sitter({
      capabilities: { ...sitter().capabilities, resolveConflicts: 'gated' }
    })
    const preparation = computeDesiredAction(conflicted, gated, ledger())
    if (!preparation) {
      throw new Error('expected conflict preparation')
    }
    expect(gateDesiredAction(preparation, conflicted, gated, ledger(), { state: 'clear' })).toEqual(
      { verdict: 'allow' }
    )

    const disabled = sitter({
      capabilities: { ...sitter().capabilities, resolveConflicts: 'off' }
    })
    expect(
      gateDesiredAction(preparation, conflicted, disabled, ledger(), { state: 'clear' })
    ).toEqual({ verdict: 'escalate', reason: 'conflict-resolution-disabled' })
  })
})
