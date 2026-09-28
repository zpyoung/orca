import { describe, expect, it } from 'vitest'
import { gateAction } from '../fork-heimdall/gate'
import type { WatcherLedger } from '../fork-heimdall/ledger-types'
import { hostedReviewAttemptFingerprint, hostedReviewContentIdentity } from './action-identity'
import {
  buildMergeAction,
  buildPrepareConflictAction,
  buildUpdateAction
} from './decision-action-builders'
import { actionWritesWorktree, hostedReviewPreflight } from './gating'
import type {
  HostedReviewSitterAction,
  HostedReviewSitterContention,
  HostedReviewSitterDefinition,
  HostedReviewSnapshot,
  HostedReviewWorldSnapshot
} from './types'

function review(overrides: Partial<HostedReviewSnapshot> = {}): HostedReviewSnapshot {
  return {
    provider: 'github',
    reviewNumber: 42,
    url: 'https://github.com/acme/repo/pull/42',
    lifecycle: 'open',
    headSha: 'head-1',
    baseSha: 'base-1',
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

function definition(
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

function snapshot(
  reviewSnapshot: HostedReviewSnapshot = review(),
  sitterDefinition: HostedReviewSitterDefinition = definition()
): HostedReviewWorldSnapshot {
  return {
    freshness: 'live',
    contentIdentity: hostedReviewContentIdentity(reviewSnapshot),
    observedAtMs: 5_000,
    world: {
      review: reviewSnapshot,
      definition: sitterDefinition,
      preparedCommit: null
    }
  }
}

function action(kind: HostedReviewSitterAction['kind']): HostedReviewSitterAction {
  const reviewSnapshot = review({ behindBase: true, conflicts: 'present' })
  const common = {
    contentIdentity: hostedReviewContentIdentity(reviewSnapshot),
    evidenceKey: `evidence:${kind}`,
    headSha: reviewSnapshot.headSha,
    reviewUrl: reviewSnapshot.url
  }
  switch (kind) {
    case 'rerun-check':
      return {
        ...common,
        kind,
        capability: 'fixChecks',
        visibility: 'external',
        expectedState: {
          target: `${reviewSnapshot.url}#check:test`,
          before: reviewSnapshot.headSha
        },
        checkKey: 'test',
        checkIds: ['check-1'],
        observationIds: ['test:1'],
        failureSignature: 'failure:test'
      }
    case 'prepare-fix':
      return {
        ...common,
        kind,
        capability: 'fixChecks',
        visibility: 'local',
        checkKey: 'test',
        checkIds: ['check-1'],
        observationIds: ['test:1'],
        failureSignature: 'failure:test',
        evidence: 'fresh-rerun'
      }
    case 'publish-fix':
      return {
        ...common,
        kind,
        capability: 'fixChecks',
        visibility: 'external',
        expectedState: { target: reviewSnapshot.url, before: reviewSnapshot.headSha },
        checkKey: 'test',
        failureSignature: 'failure:test',
        preparationActionId: 'prepare-1',
        preparedCommitSha: 'commit-1'
      }
    case 'prepare-conflict-resolution':
      return {
        ...common,
        kind,
        capability: 'resolveConflicts',
        visibility: 'local',
        baseSha: reviewSnapshot.baseSha
      }
    case 'publish-conflict-resolution':
      return {
        ...common,
        kind,
        capability: 'resolveConflicts',
        visibility: 'external',
        expectedState: { target: reviewSnapshot.url, before: reviewSnapshot.headSha },
        baseSha: reviewSnapshot.baseSha,
        preparationActionId: 'prepare-1',
        preparedCommitSha: 'commit-1'
      }
    case 'update-branch':
      return {
        ...common,
        kind,
        capability: 'updateBranch',
        visibility: 'external',
        expectedState: { target: 'refs/heads/feature', before: reviewSnapshot.headSha },
        baseSha: reviewSnapshot.baseSha,
        mode: 'merge-base-update'
      }
    case 'merge':
      return {
        ...common,
        kind,
        capability: 'merge',
        visibility: 'external',
        expectedState: { target: reviewSnapshot.url, before: reviewSnapshot.headSha },
        mergeMethod: 'squash'
      }
    case 'enqueue':
      return {
        ...common,
        kind,
        capability: 'merge',
        visibility: 'external',
        expectedState: { target: reviewSnapshot.url, before: reviewSnapshot.headSha }
      }
  }
}

function retryableFailureLedger(action: HostedReviewSitterAction): WatcherLedger {
  return {
    watcherId: 'sitter-1',
    entries: [
      {
        eventId: 'merge-failed',
        watcherId: 'sitter-1',
        atMs: 1_000,
        origin: 'owner',
        class: 'fact',
        kind: 'attempt',
        attemptId: 'merge-attempt-1',
        fingerprint: hostedReviewAttemptFingerprint(action),
        action,
        state: 'settled',
        effect: 'not-landed'
      }
    ]
  }
}

function gateEnrollment(sitterDefinition: HostedReviewSitterDefinition) {
  return {
    enabled: true,
    capabilities: sitterDefinition.capabilities,
    budget: { wallClockActiveMs: 60_000, turns: 10 }
  }
}

describe('hosted-review kind preflight', () => {
  it('classifies worktree writes by action and provider execution path', () => {
    const github = definition()
    const gitlab = definition({ provider: 'gitlab' })
    const updateBranchAction = action('update-branch')
    if (updateBranchAction.kind !== 'update-branch') {
      throw new Error('expected update-branch action')
    }
    const rebaseUpdate = { ...updateBranchAction, mode: 'rebase' as const }

    expect(actionWritesWorktree(action('prepare-fix'), github)).toBe(true)
    expect(actionWritesWorktree(action('publish-fix'), github)).toBe(true)
    expect(actionWritesWorktree(action('prepare-conflict-resolution'), github)).toBe(true)
    expect(actionWritesWorktree(action('publish-conflict-resolution'), github)).toBe(true)
    expect(actionWritesWorktree(action('update-branch'), github)).toBe(false)
    expect(actionWritesWorktree(action('update-branch'), gitlab)).toBe(true)
    expect(actionWritesWorktree(rebaseUpdate, github)).toBe(true)

    expect(actionWritesWorktree(action('rerun-check'), github)).toBe(false)
    expect(actionWritesWorktree(action('merge'), github)).toBe(false)
    expect(actionWritesWorktree(action('enqueue'), github)).toBe(false)
  })

  it.each<{
    contention: HostedReviewSitterContention
    expected: { verdict: 'allow' | 'hold' | 'escalate'; reason?: string }
  }>([
    { contention: { state: 'clear' }, expected: { verdict: 'allow' } },
    { contention: { state: 'dirty' }, expected: { verdict: 'hold', reason: 'local-changes' } },
    {
      contention: { state: 'foreign-agent', sessionId: 'agent-1' },
      expected: { verdict: 'hold', reason: 'foreign-agent' }
    },
    {
      contention: { state: 'sitter-fix-agent', actionId: 'attempt-1' },
      expected: { verdict: 'hold', reason: 'action-in-flight' }
    },
    {
      contention: { state: 'unverifiable', reason: 'host-offline' },
      expected: { verdict: 'hold', reason: 'contention-unverifiable' }
    },
    {
      contention: { state: 'abandoned-sitter-fix', actionId: 'attempt-1' },
      expected: { verdict: 'escalate', reason: 'abandoned-fix' }
    }
  ])('maps $contention.state for a worktree update', ({ contention, expected }) => {
    const reviewSnapshot = review({ behindBase: true })
    const sitterDefinition = definition({ branchUpdateMode: 'rebase' })
    const world = snapshot(reviewSnapshot, sitterDefinition)
    const update = buildUpdateAction(reviewSnapshot, sitterDefinition)
    expect(hostedReviewPreflight(update, world, contention)).toEqual(expected)
  })

  it('allows GitHub provider updates but holds GitLab and rebase updates on contention', () => {
    const dirty: HostedReviewSitterContention = { state: 'dirty' }
    const githubReview = review({ behindBase: true })
    const github = definition()
    const githubWorld = snapshot(githubReview, github)
    expect(
      hostedReviewPreflight(buildUpdateAction(githubReview, github), githubWorld, dirty)
    ).toEqual({ verdict: 'allow' })

    const gitlabUrl = 'https://gitlab.com/acme/repo/-/merge_requests/42'
    const gitlabReview = review({ provider: 'gitlab', url: gitlabUrl, behindBase: true })
    const gitlab = definition({ provider: 'gitlab', reviewUrl: gitlabUrl })
    const gitlabWorld = snapshot(gitlabReview, gitlab)
    expect(
      hostedReviewPreflight(buildUpdateAction(gitlabReview, gitlab), gitlabWorld, dirty)
    ).toEqual({ verdict: 'hold', reason: 'local-changes' })

    const rebase = definition({ branchUpdateMode: 'rebase' })
    expect(
      hostedReviewPreflight(
        buildUpdateAction(githubReview, rebase),
        snapshot(githubReview, rebase),
        dirty
      )
    ).toEqual({ verdict: 'hold', reason: 'local-changes' })
  })

  it('does not let unrelated worktree contention block provider-only actions', () => {
    const reviewSnapshot = review()
    const world = snapshot(reviewSnapshot)
    const merge = buildMergeAction(reviewSnapshot, world.world.definition)
    if (!merge) {
      throw new Error('expected merge')
    }
    for (const contention of [
      { state: 'dirty' },
      { state: 'foreign-agent', sessionId: 'agent-1' },
      { state: 'unverifiable', reason: 'host-offline' },
      { state: 'abandoned-sitter-fix', actionId: 'attempt-1' }
    ] satisfies HostedReviewSitterContention[]) {
      expect(hostedReviewPreflight(merge, world, contention)).toEqual({ verdict: 'allow' })
    }
  })

  it.each([
    { queueRequired: false, actionKind: 'merge' },
    { queueRequired: true, actionKind: 'enqueue' }
  ] as const)(
    'does not rearm $actionKind on observation churn but does on new required-check evidence',
    ({ queueRequired, actionKind }) => {
      const defaultCheck = review().checks[0]!
      const originalReview = review({
        queue: { required: queueRequired, membership: 'not-enqueued' },
        checks: [
          { ...defaultCheck, observationId: 'test:old' },
          {
            ...defaultCheck,
            checkKey: 'lint',
            checkId: 'check-2',
            name: 'lint',
            observationId: 'lint:old'
          }
        ]
      })
      const sitterDefinition = definition()
      const originalAction = buildMergeAction(originalReview, sitterDefinition)
      if (!originalAction) {
        throw new Error(`expected ${actionKind}`)
      }
      expect(originalAction.kind).toBe(actionKind)
      expect(originalAction.evidenceKey).toBe(
        queueRequired
          ? JSON.stringify(['enqueue', 'head-1', 'lint=passed', 'test=passed'])
          : JSON.stringify(['merge', 'head-1', 'squash', 'lint=passed', 'test=passed'])
      )

      const churnedReview = review({
        queue: { required: queueRequired, membership: 'not-enqueued' },
        checks: [
          {
            ...defaultCheck,
            checkKey: 'lint',
            checkId: 'check-2',
            name: 'lint',
            observationId: 'lint:new'
          },
          { ...defaultCheck, observationId: 'test:new' }
        ]
      })
      const churnedAction = buildMergeAction(churnedReview, sitterDefinition)
      if (!churnedAction) {
        throw new Error(`expected churned ${actionKind}`)
      }
      expect(churnedAction.evidenceKey).toBe(originalAction.evidenceKey)
      expect(
        gateAction(
          churnedAction,
          snapshot(churnedReview, sitterDefinition),
          gateEnrollment(sitterDefinition),
          retryableFailureLedger(originalAction)
        )
      ).toEqual({ verdict: 'hold', reason: 'retry-needs-new-evidence' })

      const changedIdentityReview = review({
        queue: { required: queueRequired, membership: 'not-enqueued' },
        checks: [
          { ...defaultCheck, observationId: 'test:new' },
          {
            ...defaultCheck,
            checkKey: 'typecheck',
            checkId: 'check-3',
            name: 'typecheck',
            observationId: 'typecheck:1'
          }
        ]
      })
      const changedIdentityAction = buildMergeAction(changedIdentityReview, sitterDefinition)
      if (!changedIdentityAction) {
        throw new Error(`expected changed-evidence ${actionKind}`)
      }
      expect(changedIdentityAction.evidenceKey).not.toBe(originalAction.evidenceKey)
      expect(
        gateAction(
          changedIdentityAction,
          snapshot(changedIdentityReview, sitterDefinition),
          gateEnrollment(sitterDefinition),
          retryableFailureLedger(originalAction)
        )
      ).toEqual({ verdict: 'allow' })

      const gatedDefinition = definition({
        capabilities: { ...sitterDefinition.capabilities, merge: 'gated' }
      })
      expect(
        gateAction(
          changedIdentityAction,
          snapshot(changedIdentityReview, gatedDefinition),
          gateEnrollment(gatedDefinition),
          retryableFailureLedger(originalAction)
        )
      ).toMatchObject({ verdict: 'hold', reason: 'awaiting-approval' })

      const changedStateAction = buildMergeAction(
        {
          ...originalReview,
          checks: originalReview.checks.map((check) =>
            check.checkKey === 'lint' ? { ...check, state: 'failed' as const } : check
          )
        },
        sitterDefinition
      )
      expect(changedStateAction?.evidenceKey).not.toBe(originalAction.evidenceKey)
    }
  )

  it('escalates a review identity mismatch before considering contention', () => {
    const reviewSnapshot = review()
    const mismatched = definition({ reviewNumber: 99 })
    const world = snapshot(reviewSnapshot, mismatched)
    const merge = buildMergeAction(reviewSnapshot, definition())
    if (!merge) {
      throw new Error('expected merge')
    }
    expect(hostedReviewPreflight(merge, world, { state: 'clear' })).toEqual({
      verdict: 'escalate',
      reason: 'review-identity-mismatch'
    })
  })

  it('retains pure builder actions with kernel content identity and conditional external writes', () => {
    const reviewSnapshot = review({ behindBase: true })
    const update = buildUpdateAction(reviewSnapshot, definition())
    expect(update).toMatchObject({
      visibility: 'external',
      contentIdentity: hostedReviewContentIdentity(reviewSnapshot),
      expectedState: {
        target: 'refs/heads/feature',
        before: reviewSnapshot.headSha
      }
    })

    const preparation = buildPrepareConflictAction(reviewSnapshot)
    expect(preparation).toMatchObject({
      visibility: 'local',
      contentIdentity: hostedReviewContentIdentity(reviewSnapshot)
    })
    expect(preparation.expectedState).toBeUndefined()
  })
})
