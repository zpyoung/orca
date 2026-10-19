import { describe, expect, it } from 'vitest'
import type { WatcherLedger } from '../fork-heimdall/ledger-types'
import { hostedReviewAttemptFingerprint } from './action-identity'
import { explainDesiredAction } from './decision'
import type {
  HostedReviewAttemptEntry,
  HostedReviewCheckSnapshot,
  HostedReviewSitterAction,
  HostedReviewSitterDefinition,
  HostedReviewSnapshot
} from './types'

const HEAD = 'head-1'

function check(overrides: Partial<HostedReviewCheckSnapshot> = {}): HostedReviewCheckSnapshot {
  return {
    checkKey: 'test',
    checkId: 'workflow:900:check:1',
    name: 'test',
    required: true,
    headSha: HEAD,
    state: 'failed',
    observationId: 'test:1',
    failureSignature: 'failure:test',
    ...overrides
  }
}

function sibling(overrides: Partial<HostedReviewCheckSnapshot> = {}): HostedReviewCheckSnapshot {
  return check({
    checkKey: 'lint',
    checkId: 'workflow:900:check:2',
    name: 'lint',
    required: false,
    state: 'passed',
    observationId: 'lint:1',
    failureSignature: null,
    ...overrides
  })
}

function review(
  checks: HostedReviewCheckSnapshot[],
  provider: HostedReviewSnapshot['provider'] = 'github'
): HostedReviewSnapshot {
  return {
    provider,
    reviewNumber: 42,
    url: 'https://github.com/acme/repo/pull/42',
    lifecycle: 'open',
    headSha: HEAD,
    baseSha: 'base-1',
    draft: false,
    checks,
    checksComplete: true,
    providerReadiness: { verdict: 'blocked', blockers: ['checks'] },
    behindBase: false,
    conflicts: 'none',
    queue: { required: false, membership: 'not-enqueued' },
    defaultMergeMethod: 'squash'
  }
}

const sitter: HostedReviewSitterDefinition = {
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
  mergeCheckScope: 'required'
}

function notLandedAttempt(action: HostedReviewSitterAction): HostedReviewAttemptEntry {
  return {
    kind: 'attempt',
    class: 'fact',
    origin: 'owner',
    watcherId: 'sitter-1',
    eventId: `event:${action.evidenceKey}`,
    attemptId: `attempt:${action.evidenceKey}`,
    atMs: 1_000,
    action,
    fingerprint: hostedReviewAttemptFingerprint(action),
    state: 'settled',
    effect: 'not-landed',
    reason: 'workflow-run-in-progress'
  }
}

function ledger(entries: readonly HostedReviewAttemptEntry[] = []): WatcherLedger {
  return { watcherId: 'sitter-1', entries }
}

function decide(input: HostedReviewSnapshot, history: WatcherLedger = ledger()) {
  return explainDesiredAction(input, sitter, history, { freshness: 'live', preparedCommit: null })
}

describe('PR sitter reruns against a GitHub workflow run', () => {
  it('waits for the rest of the workflow run before rerunning its failed job', () => {
    const otherRun = sibling({
      checkKey: 'docs',
      checkId: 'workflow:901:check:3',
      state: 'pending',
      observationId: 'docs:1'
    })

    const outcome = decide(review([check(), sibling({ state: 'pending' }), otherRun]))
    expect(outcome.action).toBeNull()
    if (outcome.action === null && 'considered' in outcome) {
      expect(outcome.considered).toContainEqual(
        expect.objectContaining({ phase: 'fix-checks', reason: 'awaiting-workflow-run' })
      )
    }

    expect(decide(review([check(), sibling(), otherRun])).action).toMatchObject({
      kind: 'rerun-check',
      checkIds: ['workflow:900:check:1']
    })
  })

  it('does not wait on a GitLab pipeline, whose jobs retry individually', () => {
    const job = check({ checkId: 'job:acme%2Frepo:1' })
    const running = sibling({ checkId: 'job:acme%2Frepo:2', state: 'pending' })

    expect(decide(review([job, running], 'gitlab')).action).toMatchObject({
      kind: 'rerun-check'
    })
  })

  it('retries a rerun that landed nothing once its workflow run moves on', () => {
    const refused = decide(review([check(), sibling()])).action
    if (refused?.kind !== 'rerun-check') {
      throw new Error('expected rerun')
    }
    const history = ledger([notLandedAttempt(refused)])

    // the gate holds an identical fingerprint, so a retry needs evidence the run moved
    const unchanged = decide(review([check(), sibling()]), history).action
    expect(unchanged && hostedReviewAttemptFingerprint(unchanged)).toBe(
      hostedReviewAttemptFingerprint(refused)
    )

    const retry = decide(review([check(), sibling({ observationId: 'lint:2' })]), history).action
    expect(retry).toMatchObject({ kind: 'rerun-check', checkIds: ['workflow:900:check:1'] })
    expect(retry && hostedReviewAttemptFingerprint(retry)).not.toBe(
      hostedReviewAttemptFingerprint(refused)
    )
  })
})
