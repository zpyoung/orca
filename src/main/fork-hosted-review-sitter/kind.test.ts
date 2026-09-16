import { describe, expect, it, vi } from 'vitest'
import type { ExecuteContext } from '../../shared/fork-heimdall/kind-contract'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import {
  buildMergeAction,
  hostedReviewAttemptFingerprint,
  actionWritesWorktree,
  type HostedReviewSitterAction,
  type HostedReviewSitterContention,
  type HostedReviewWorld
} from '../../shared/fork-hosted-review-sitter'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { HostedReviewWorkerDispatch } from './agent-preparation'
import { createHostedReviewKind, registerHostedReviewKind, type HostedReviewKind } from './kind'
import type { WatcherRunner } from '../fork-heimdall/runner-state'
import { WatcherRunnerStopLifecycle } from '../fork-heimdall/runner-stop-lifecycle'
import type { WatcherRunnerStatusLifecycle } from '../fork-heimdall/runner-status'

const { inspectContention, launchFix } = vi.hoisted(() => ({
  inspectContention: vi.fn<() => Promise<HostedReviewSitterContention>>(),
  launchFix: vi.fn()
}))
vi.mock('./contention', () => ({
  inspectHostedReviewSitterContention: inspectContention
}))
vi.mock('./agent', () => ({
  launchHostedReviewSitterFixAgent: launchFix
}))

const definition = {
  repoId: 'repo-1',
  worktreeId: 'repo-1::/work/repo',
  repoPath: '/work/repo',
  branch: 'feature',
  provider: 'github',
  reviewNumber: 42,
  reviewUrl: 'https://github.com/acme/repo/pull/42',
  capabilities: { updateBranch: 'on', resolveConflicts: 'gated', fixChecks: 'on', merge: 'gated' },
  branchUpdateMode: 'merge-base-update',
  mergeMethod: 'squash'
} as const

const review = {
  provider: 'github',
  reviewNumber: 42,
  url: definition.reviewUrl,
  lifecycle: 'open',
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  draft: false,
  checks: [],
  checksComplete: true,
  providerReadiness: { verdict: 'ready', blockers: [] },
  behindBase: false,
  conflicts: 'none',
  queue: { required: false, membership: 'not-enqueued' },
  defaultMergeMethod: 'squash'
} as const

const snapshot: Snapshot<HostedReviewWorld> = {
  freshness: 'live',
  contentIdentity: JSON.stringify([review.headSha, review.baseSha]),
  observedAtMs: 1,
  world: { review, definition, preparedCommit: null }
}

function fakeStore(): Store {
  return {
    getRepo: () => ({ id: 'repo-1' }),
    getSettings: () => ({
      defaultTuiAgent: 'claude',
      disabledTuiAgents: [],
      sourceControlAi: undefined,
      commitMessageAi: undefined
    })
  } as unknown as Store
}

const runtime = { launchAgentTerminal: vi.fn() } as unknown as OrcaRuntimeService

function attemptLedger(
  action: HostedReviewSitterAction,
  state: 'running' | 'settled',
  effect?: 'landed' | 'not-landed' | 'indeterminate'
): WatcherLedger {
  return {
    watcherId: 'watcher-1',
    entries: [
      {
        eventId: `attempt-${state}-${effect ?? 'pending'}`,
        watcherId: 'watcher-1',
        atMs: 1,
        origin: 'owner',
        class: 'fact',
        kind: 'attempt',
        attemptId: 'attempt-1',
        fingerprint: hostedReviewAttemptFingerprint(action),
        action,
        state,
        ...(effect === undefined ? {} : { effect })
      }
    ]
  }
}

describe('hosted review kind', () => {
  it('registers identity, stop predicates, and the payload schema', () => {
    let registered: HostedReviewKind | undefined
    registerHostedReviewKind({ registerKind: (kind) => (registered = kind) }, runtime, fakeStore())

    expect(registered?.id).toBe('hosted-review')
    expect(registered?.displayName).toBe('Hosted review')
    expect(registered?.stopPredicates?.map((predicate) => predicate.id)).toEqual([
      'hosted-review-lifecycle-closed',
      'repeated-failure-after-own-fix',
      'unverifiable-reproduced-failure'
    ])
    expect(
      registered?.enrollmentPayloadSchema.safeParse({
        branch: 'feature',
        provider: 'github',
        reviewNumber: 42,
        reviewUrl: definition.reviewUrl,
        branchUpdateMode: 'merge-base-update',
        mergeMethod: 'squash'
      }).success
    ).toBe(true)
  })

  it.each(['merged', 'closed'] as const)(
    'defers a %s lifecycle terminal until attempts are settled',
    async (lifecycle) => {
      const kind = createHostedReviewKind(runtime, fakeStore())
      const action = buildMergeAction(review, definition)
      if (!action) {
        throw new Error('Expected merge action')
      }
      const terminalSnapshot: Snapshot<HostedReviewWorld> = {
        ...snapshot,
        world: { ...snapshot.world, review: { ...review, lifecycle } }
      }
      const terminal = vi.fn()
      const assertHeld = vi.fn(async () => undefined)
      const runner = {
        kind,
        leaseGuard: {
          epoch: 1,
          assertHeld,
          renewLoop: () => ({ dispose: () => undefined })
        }
      } as unknown as WatcherRunner
      const stopLifecycle = new WatcherRunnerStopLifecycle({
        terminal,
        park: vi.fn()
      } as unknown as WatcherRunnerStatusLifecycle)

      await expect(
        stopLifecycle.evaluate(runner, terminalSnapshot, attemptLedger(action, 'running'))
      ).resolves.toBe('deferred')
      await expect(
        stopLifecycle.evaluate(
          runner,
          terminalSnapshot,
          attemptLedger(action, 'settled', 'indeterminate')
        )
      ).resolves.toBe('deferred')
      expect(assertHeld).not.toHaveBeenCalled()
      expect(terminal).not.toHaveBeenCalled()

      const settledEffect = lifecycle === 'merged' ? 'landed' : 'not-landed'
      await expect(
        stopLifecycle.evaluate(
          runner,
          terminalSnapshot,
          attemptLedger(action, 'settled', settledEffect)
        )
      ).resolves.toBe('terminal')
      expect(assertHeld).toHaveBeenCalledOnce()
      expect(terminal).toHaveBeenCalledWith(runner, {
        predicateId: 'hosted-review-lifecycle-closed',
        disposition: 'terminal',
        reason: `review ${lifecycle}`,
        detail: review.headSha
      })
    }
  )

  it.each([
    [{ state: 'clear' }, { verdict: 'allow' }],
    [
      { state: 'dirty', reason: 'local-changes' },
      { verdict: 'hold', reason: 'local-changes' }
    ],
    [
      { state: 'foreign-agent', sessionId: 't-1' },
      { verdict: 'hold', reason: 'foreign-agent' }
    ],
    [
      { state: 'sitter-fix-agent', actionId: 'a-1' },
      { verdict: 'hold', reason: 'action-in-flight' }
    ],
    [
      { state: 'unverifiable', reason: 'git-unreachable' },
      { verdict: 'hold', reason: 'contention-unverifiable' }
    ],
    [
      { state: 'abandoned-sitter-fix', actionId: 'old' },
      { verdict: 'escalate', reason: 'abandoned-fix' }
    ]
  ] as const)('maps contention %j through kind preflight', async (contention, verdict) => {
    inspectContention.mockResolvedValueOnce(contention)
    const action = {
      kind: 'prepare-fix',
      reviewUrl: definition.reviewUrl
    } as HostedReviewSitterAction
    const kind = createHostedReviewKind(runtime, fakeStore())
    await expect(
      kind.preflight!(action, snapshot, { watcherId: 'watcher-1', entries: [] }, {} as never)
    ).resolves.toEqual(verdict)
  })

  it('marks only local worktree mutations as contention-sensitive', async () => {
    expect(
      actionWritesWorktree({ kind: 'prepare-fix' } as HostedReviewSitterAction, definition)
    ).toBe(true)
    expect(
      actionWritesWorktree(
        { kind: 'prepare-conflict-resolution' } as HostedReviewSitterAction,
        definition
      )
    ).toBe(true)
    expect(
      actionWritesWorktree({ kind: 'publish-fix' } as HostedReviewSitterAction, definition)
    ).toBe(true)
    expect(
      actionWritesWorktree(
        { kind: 'publish-conflict-resolution' } as HostedReviewSitterAction,
        definition
      )
    ).toBe(true)
    expect(
      actionWritesWorktree(
        { kind: 'update-branch', mode: 'merge-base-update' } as HostedReviewSitterAction,
        definition
      )
    ).toBe(false)
    expect(
      actionWritesWorktree(
        { kind: 'update-branch', mode: 'rebase' } as HostedReviewSitterAction,
        definition
      )
    ).toBe(true)
    expect(
      actionWritesWorktree(
        { kind: 'update-branch', mode: 'merge-base-update' } as HostedReviewSitterAction,
        { ...definition, provider: 'gitlab' }
      )
    ).toBe(true)
    expect(
      actionWritesWorktree({ kind: 'rerun-check' } as HostedReviewSitterAction, definition)
    ).toBe(false)
    expect(actionWritesWorktree({ kind: 'merge' } as HostedReviewSitterAction, definition)).toBe(
      false
    )
    inspectContention.mockClear()
    const kind = createHostedReviewKind(runtime, fakeStore())
    await expect(
      kind.preflight!(
        { kind: 'rerun-check', reviewUrl: definition.reviewUrl } as HostedReviewSitterAction,
        snapshot,
        { watcherId: 'watcher-1', entries: [] },
        {} as never
      )
    ).resolves.toEqual({ verdict: 'allow' })
    expect(inspectContention).not.toHaveBeenCalled()
  })

  it('dispatches autonomous preparation through the fenced worker capability only', async () => {
    const kind = createHostedReviewKind(runtime, fakeStore())
    const dispatchWorker = vi.fn(async (_request: HostedReviewWorkerDispatch) => ({
      status: 'dispatched' as const,
      dispatchId: 'd-1'
    }))
    const action: HostedReviewSitterAction = {
      kind: 'prepare-fix',
      capability: 'fixChecks',
      visibility: 'local',
      contentIdentity: snapshot.contentIdentity,
      evidenceKey: 'failure:test',
      headSha: review.headSha,
      reviewUrl: definition.reviewUrl,
      checkKey: 'test',
      checkIds: ['check-1'],
      observationIds: ['observation-1'],
      failureSignature: 'failure:test',
      evidence: 'fresh-rerun'
    }
    const context: ExecuteContext<HostedReviewWorld> = {
      snapshot,
      ledger: { watcherId: 'watcher-1', entries: [] },
      lease: {
        epoch: 1,
        assertHeld: vi.fn(async () => undefined),
        renewLoop: () => ({ dispose: () => undefined })
      },
      dispatchWorker
    }

    await expect(kind.execute(action, context)).resolves.toMatchObject({ effect: 'landed' })
    expect(dispatchWorker).toHaveBeenCalledOnce()
    const request = dispatchWorker.mock.calls[0]![0]
    expect(request.spec).toContain('Orca-Heimdall-Attempt:')
    expect(request.spec.toLowerCase()).toContain('local commit')
    expect(request.spec.toLowerCase()).toContain('do not push')
    expect(launchFix).not.toHaveBeenCalled()
    expect(runtime.launchAgentTerminal).not.toHaveBeenCalled()
  })
})
