import { describe, expect, it } from 'vitest'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import type {
  HostedReviewCheckSnapshot,
  HostedReviewSitterCapabilities,
  HostedReviewSitterDefinition,
  HostedReviewSnapshot,
  HostedReviewWorld
} from '../../shared/fork-hosted-review-sitter/types'
import { createHostedReviewOwnerAdapter } from './owner-adapter'

const HEAD = 'head-1'
const BASE = 'base-1'

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
    checks: [check()],
    checksComplete: true,
    providerReadiness: { verdict: 'blocked', blockers: ['checks'] },
    behindBase: false,
    conflicts: 'none',
    queue: { required: false, membership: 'not-enqueued' },
    defaultMergeMethod: 'squash',
    ...overrides
  }
}

function definition(capabilities: HostedReviewSitterCapabilities): HostedReviewSitterDefinition {
  return {
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    repoPath: '/repo',
    branch: 'feature',
    provider: 'github',
    reviewNumber: 42,
    reviewUrl: 'https://github.com/acme/repo/pull/42',
    capabilities,
    branchUpdateMode: 'merge-base-update',
    mergeMethod: null
  }
}

function enrollment(capabilities: Record<string, 'off' | 'gated' | 'on'>): WatcherEnrollment {
  return {
    watcherId: 'sitter-1',
    kind: 'hosted-review',
    workspaceKey: 'local::/repo',
    executionHostId: 'local',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    workspacePath: '/repo',
    schedulerOwner: 'local_host_service',
    enabled: true,
    paused: false,
    commandRevision: 0,
    capabilities,
    budget: { wallClockActiveMs: null, turns: null },
    kindPayload: {},
    coordinatorIdentity: { handle: 'coordinator', paneKey: 'pane-1' },
    orchestrationRunId: null,
    createdAtMs: 0,
    terminalAtMs: null
  }
}

function snapshot(world: HostedReviewWorld) {
  return { freshness: 'live' as const, contentIdentity: 'content-1', observedAtMs: 0, world }
}

function ledger(): WatcherLedger {
  return { watcherId: 'sitter-1', entries: [] }
}

const ON_CAPS: HostedReviewSitterCapabilities = {
  updateBranch: 'on',
  resolveConflicts: 'on',
  fixChecks: 'on',
  merge: 'gated'
}

describe('hosted review sitter owner adapter', () => {
  const adapter = createHostedReviewOwnerAdapter()

  it('refuses skip-capability for a capability the enrollment withheld', () => {
    const caps = { ...ON_CAPS, fixChecks: 'off' as const }
    const rejection = adapter.rejectIntervention(
      { kind: 'skip-capability', capability: 'fixChecks', rationale: 'go' },
      snapshot({ review: review(), definition: definition(caps), preparedCommit: null }),
      ledger(),
      enrollment(caps)
    )
    expect(rejection).toMatchObject({ gate: 'sitter-overrides' })
  })

  it('refuses skip-capability for merge regardless of mode', () => {
    for (const mode of ['off', 'gated', 'on'] as const) {
      const caps = { ...ON_CAPS, merge: mode }
      const rejection = adapter.rejectIntervention(
        { kind: 'skip-capability', capability: 'merge', rationale: 'go' },
        snapshot({ review: review(), definition: definition(caps), preparedCommit: null }),
        ledger(),
        enrollment(caps)
      )
      expect(rejection).toMatchObject({ gate: 'sitter-overrides' })
    }
  })

  it('keeps refusing an off or merge capability when the enrollment also carries owner-intervention', () => {
    const caps = { ...ON_CAPS, fixChecks: 'off' as const, 'owner-intervention': 'on' as const }
    const offRejection = adapter.rejectIntervention(
      { kind: 'skip-capability', capability: 'fixChecks', rationale: 'go' },
      snapshot({ review: review(), definition: definition(ON_CAPS), preparedCommit: null }),
      ledger(),
      enrollment(caps)
    )
    expect(offRejection).toMatchObject({ gate: 'sitter-overrides' })

    const mergeRejection = adapter.rejectIntervention(
      { kind: 'skip-capability', capability: 'merge', rationale: 'go' },
      snapshot({ review: review(), definition: definition(ON_CAPS), preparedCommit: null }),
      ledger(),
      enrollment(caps)
    )
    expect(mergeRejection).toMatchObject({ gate: 'sitter-overrides' })
  })

  it('refuses retry-rung when its governing capability is off', () => {
    const caps = { ...ON_CAPS, updateBranch: 'off' as const }
    const rejection = adapter.rejectIntervention(
      { kind: 'retry-rung', rung: 'update-branch', rationale: 'go' },
      snapshot({ review: review(), definition: definition(caps), preparedCommit: null }),
      ledger(),
      enrollment(caps)
    )
    expect(rejection).toMatchObject({ gate: 'sitter-overrides' })
  })

  it('refuses retry-rung for merge and enqueue', () => {
    for (const rung of ['merge', 'enqueue'] as const) {
      const rejection = adapter.rejectIntervention(
        { kind: 'retry-rung', rung, rationale: 'go' },
        snapshot({ review: review(), definition: definition(ON_CAPS), preparedCommit: null }),
        ledger(),
        enrollment(ON_CAPS)
      )
      expect(rejection).toMatchObject({ gate: 'sitter-overrides' })
    }
  })

  it('allows skip-capability that only bypasses an approval gate', () => {
    const caps = { ...ON_CAPS, fixChecks: 'gated' as const }
    const rejection = adapter.rejectIntervention(
      { kind: 'skip-capability', capability: 'fixChecks', rationale: 'go' },
      snapshot({ review: review(), definition: definition(caps), preparedCommit: null }),
      ledger(),
      enrollment(caps)
    )
    expect(rejection).toBeNull()
  })

  it('builds a fresh-evidence action for an accepted retry-rung', () => {
    const behind = review({ behindBase: true })
    const action = adapter.actionForIntervention(
      { kind: 'retry-rung', rung: 'update-branch', rationale: 'base moved, retry now' },
      snapshot({ review: behind, definition: definition(ON_CAPS), preparedCommit: null })
    )
    expect(action.kind).toBe('update-branch')
    expect(action.evidenceKey).toContain('owner-retry')
    expect(action.evidenceKey).toContain('base moved, retry now')
  })

  it('builds the currently desired action for an accepted skip-capability', () => {
    const action = adapter.actionForIntervention(
      { kind: 'skip-capability', capability: 'fixChecks', rationale: 'go' },
      snapshot({ review: review(), definition: definition(ON_CAPS), preparedCommit: null })
    )
    expect(['rerun-check', 'prepare-fix']).toContain(action.kind)
  })

  it('keeps the stale triggering check and required live checks while making omissions visible', () => {
    const manyChecks = Array.from({ length: 40 }, (_, index) =>
      check({
        checkKey: `check-${index}`,
        checkId: `id-${index}`,
        observationId: `run:${index}`,
        state: 'passed',
        failureSignature: null
      })
    )
    const trigger = check({ checkKey: 'trigger-only', required: false, headSha: BASE })
    const pending = check({
      checkKey: 'deploy',
      checkId: 'deploy-1',
      observationId: 'deploy:1',
      state: 'pending',
      failureSignature: null
    })
    const wide = review({ checks: [trigger, pending, ...manyChecks] })
    const brief = adapter.describeState(
      snapshot({ review: wide, definition: definition(ON_CAPS), preparedCommit: null }),
      ledger(),
      2_048,
      {
        deviation: {
          kind: 'check-failed',
          criterionId: 'trigger-only',
          command: null,
          exitCode: null,
          timedOut: null
        }
      }
    )
    const state = JSON.parse(brief.text) as {
      checks: { checkKey: string; required: boolean; current: boolean; state: string }[]
      omissions?: { checks?: { count: number; reference: string } }
    }

    expect(Buffer.byteLength(brief.text, 'utf8')).toBeLessThanOrEqual(2_048)
    expect(brief.truncated).toBe(true)
    expect(state.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkKey: 'trigger-only', current: false, state: 'failed' }),
        expect.objectContaining({ checkKey: 'deploy', required: true, state: 'pending' })
      ])
    )
    expect(state.omissions?.checks).toMatchObject({
      count: expect.any(Number),
      reference: 'snapshot.world.review.checks'
    })
    expect(state.omissions?.checks?.count).toBeGreaterThan(0)
  })
})
