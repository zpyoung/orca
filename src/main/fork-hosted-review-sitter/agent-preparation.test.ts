import { describe, expect, it, vi } from 'vitest'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import {
  hostedReviewAttemptFingerprint,
  hostedReviewContentIdentity
} from '../../shared/fork-hosted-review-sitter/action-identity'
import type {
  HostedReviewSitterAction,
  HostedReviewSitterDefinition,
  HostedReviewSnapshot,
  PrepareFixAction
} from '../../shared/fork-hosted-review-sitter/types'
import type { Store } from '../persistence'
import { buildHostedReviewWorkerDispatch } from './agent-preparation'

const { resolveSourceControlActionRecipeMock } = vi.hoisted(() => ({
  resolveSourceControlActionRecipeMock: vi.fn()
}))

vi.mock('../../shared/source-control-ai', () => ({
  resolveSourceControlActionRecipe: resolveSourceControlActionRecipeMock
}))

const REVIEW_URL = 'https://github.com/acme/repo/pull/42'
const CURRENT_HEAD = 'head-3'

function definition(): HostedReviewSitterDefinition {
  return {
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    repoPath: '/repo',
    branch: 'feature',
    provider: 'github',
    reviewNumber: 42,
    reviewUrl: REVIEW_URL,
    capabilities: { updateBranch: 'on', resolveConflicts: 'on', fixChecks: 'on', merge: 'on' },
    branchUpdateMode: 'merge-base-update',
    mergeMethod: null,
    mergeCheckScope: 'required',
    repeatFixLimit: 3
  }
}

function review(): HostedReviewSnapshot {
  return {
    provider: 'github',
    reviewNumber: 42,
    url: REVIEW_URL,
    lifecycle: 'open',
    headSha: CURRENT_HEAD,
    baseSha: 'base-1',
    draft: false,
    checks: [
      {
        checkKey: 'lint',
        checkId: 'lint-1',
        name: 'lint',
        required: true,
        headSha: CURRENT_HEAD,
        state: 'failed',
        observationId: 'head-3:lint-1',
        failureSignature: 'failure:formatting'
      }
    ],
    checksComplete: true,
    providerReadiness: { verdict: 'blocked', blockers: ['checks'] },
    behindBase: false,
    conflicts: 'none',
    queue: { required: false, membership: 'not-enqueued' },
    defaultMergeMethod: 'squash'
  }
}

function prepareFixAction(): PrepareFixAction {
  return {
    kind: 'prepare-fix',
    capability: 'fixChecks',
    visibility: 'local',
    contentIdentity: hostedReviewContentIdentity(review()),
    evidenceKey: 'prepare-fix:head-3:lint',
    headSha: CURRENT_HEAD,
    reviewUrl: REVIEW_URL,
    checkKey: 'lint',
    checkIds: ['lint-1'],
    observationIds: ['head-3:lint-1'],
    failureSignature: 'failure:formatting',
    evidence: 'same-shard-multi-node'
  }
}

function completedPublishFixAttempt(
  attemptId: string,
  sourceHeadSha: string,
  producedHeadSha: string,
  atMs: number
): WatcherLedger['entries'][number] {
  const action: HostedReviewSitterAction = {
    kind: 'publish-fix',
    capability: 'fixChecks',
    visibility: 'external',
    contentIdentity: JSON.stringify([sourceHeadSha, 'base-1']),
    evidenceKey: `publish-fix:${attemptId}`,
    expectedState: { target: REVIEW_URL, before: sourceHeadSha },
    headSha: sourceHeadSha,
    reviewUrl: REVIEW_URL,
    checkKey: 'lint',
    failureSignature: 'failure:formatting',
    preparationActionId: `prepare:${attemptId}`,
    preparedCommitSha: producedHeadSha
  }

  return {
    kind: 'attempt',
    class: 'fact',
    origin: 'owner',
    watcherId: 'sitter-1',
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

function dispatchStore(): Store {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the only Store methods buildHostedReviewWorkerDispatch reads.
  return {
    getSettings: () => ({ defaultTuiAgent: 'codex', disabledTuiAgents: [] }),
    getRepo: () => ({ id: 'repo-1', path: '/repo' })
  } as unknown as Store
}

describe('hosted review worker dispatch repeated-failure context', () => {
  it('reads prior publish attempts from the execution ledger without changing action identity', () => {
    resolveSourceControlActionRecipeMock.mockReturnValue({
      agentId: 'codex',
      commandInputTemplate: '{basePrompt}'
    })
    const sitter = definition()
    const currentReview = review()
    const action = prepareFixAction()
    const ledger: WatcherLedger = {
      watcherId: 'sitter-1',
      entries: [
        completedPublishFixAttempt('publish-1', 'head-1', 'head-2', 1_000),
        completedPublishFixAttempt('publish-2', 'head-2', CURRENT_HEAD, 2_000)
      ]
    }
    const actionIdentity = {
      kind: action.kind,
      headSha: action.headSha,
      checkKey: action.checkKey,
      failureSignature: action.failureSignature,
      contentIdentity: action.contentIdentity,
      evidenceKey: action.evidenceKey
    }
    expect(actionIdentity).toEqual({
      kind: 'prepare-fix',
      headSha: CURRENT_HEAD,
      checkKey: 'lint',
      failureSignature: 'failure:formatting',
      contentIdentity: '["head-3","base-1"]',
      evidenceKey: 'prepare-fix:head-3:lint'
    })

    const dispatch = buildHostedReviewWorkerDispatch(
      dispatchStore(),
      sitter,
      action,
      'prepare-fingerprint',
      { review: currentReview, ledger }
    )

    expect(dispatch.spec).toContain('publish-1')
    expect(dispatch.spec).toContain('publish-2')
    expect(dispatch.spec).toContain('head-1')
    expect(dispatch.spec).toContain('head-2')
    expect(dispatch.spec).toContain(CURRENT_HEAD)
    expect(dispatch.taskKey).toBe('prepare-fix')
    expect({
      kind: action.kind,
      headSha: action.headSha,
      checkKey: action.checkKey,
      failureSignature: action.failureSignature,
      contentIdentity: action.contentIdentity,
      evidenceKey: action.evidenceKey
    }).toEqual(actionIdentity)
  })
})
