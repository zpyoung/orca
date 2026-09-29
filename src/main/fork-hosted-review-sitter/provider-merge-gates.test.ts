import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildMergeAction } from '../../shared/fork-hosted-review-sitter/decision-action-builders'
import type {
  HostedReviewCheckSnapshot,
  HostedReviewSitterDefinition,
  HostedReviewSnapshot
} from '../../shared/fork-hosted-review-sitter/types'
import { createHostedReviewSitterMutationTracker } from './provider-action-effect'
import { executeGitHubSitterAction } from './provider-github-actions'
import type { GitHubState } from './provider-github-read'
import { executeGitLabSitterAction } from './provider-gitlab-actions'
import type { GitLabState } from './provider-gitlab-read'
import type { HostedReviewSitterGitExecution } from './provider-git'

const mocks = vi.hoisted(() => ({
  loadGitHubState: vi.fn(),
  runGitHubApi: vi.fn(),
  loadGitLabState: vi.fn(),
  runGitLabApi: vi.fn()
}))

vi.mock('./provider-github-read', () => ({
  ENQUEUE_PULL_REQUEST_MUTATION: 'mutation EnqueuePullRequest',
  loadGitHubState: mocks.loadGitHubState,
  runGitHubApi: mocks.runGitHubApi,
  stringValue: (value: unknown) => (typeof value === 'string' ? value : '')
}))

vi.mock('./provider-gitlab-read', () => ({
  loadGitLabState: mocks.loadGitLabState,
  numberValue: (value: unknown) => (typeof value === 'number' ? value : null),
  runGitLabApi: mocks.runGitLabApi,
  stringValue: (value: unknown) => (typeof value === 'string' ? value : '')
}))

vi.mock('./provider-git', () => ({ throwIfAborted: vi.fn() }))

const HEAD = 'head-1'
const BASE = 'base-1'

function check(overrides: Partial<HostedReviewCheckSnapshot> = {}): HostedReviewCheckSnapshot {
  return {
    checkKey: 'required',
    checkId: 'required-1',
    name: 'required',
    required: true,
    headSha: HEAD,
    state: 'passed',
    observationId: 'required:1',
    failureSignature: null,
    ...overrides
  }
}

function review(
  provider: HostedReviewSnapshot['provider'],
  optionalState: 'pending' | 'failed'
): HostedReviewSnapshot {
  return {
    provider,
    reviewNumber: 42,
    url: 'https://example.test/review/42',
    lifecycle: 'open',
    headSha: HEAD,
    baseSha: BASE,
    draft: false,
    checks: [
      check(),
      check({
        checkKey: 'optional',
        checkId: 'optional-1',
        name: 'optional',
        required: false,
        state: optionalState,
        observationId: `optional:${optionalState}`
      })
    ],
    checksComplete: true,
    providerReadiness: { verdict: 'ready', blockers: [] },
    behindBase: false,
    conflicts: 'none',
    queue: { required: false, membership: 'not-enqueued' },
    defaultMergeMethod: 'squash'
  }
}

function definition(
  provider: HostedReviewSitterDefinition['provider']
): HostedReviewSitterDefinition {
  return {
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    repoPath: '/repo',
    branch: 'feature',
    provider,
    reviewNumber: 42,
    reviewUrl: 'https://example.test/review/42',
    capabilities: { updateBranch: 'on', resolveConflicts: 'on', fixChecks: 'on', merge: 'on' },
    branchUpdateMode: 'merge-base-update',
    mergeMethod: null,
    mergeCheckScope: 'all'
  }
}

function githubState(snapshot: HostedReviewSnapshot): GitHubState {
  return {
    snapshot,
    ownerRepo: { owner: 'acme', repo: 'repo' },
    ghOptions: {},
    pullRequestId: 'pr-42',
    baseRefName: 'main',
    sourceIdentityComplete: true
  }
}

function gitlabState(snapshot: HostedReviewSnapshot): GitLabState {
  return {
    snapshot,
    projectRef: { host: 'gitlab.com', path: 'acme/repo' },
    baseRefName: 'main',
    sourceIdentityComplete: true,
    project: {}
  }
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the provider merge gate fails before touching any Git method.
const git = {} as unknown as HostedReviewSitterGitExecution

beforeEach(() => {
  vi.clearAllMocks()
})

describe('hosted review provider final merge gates', () => {
  it.each(['pending', 'failed'] as const)(
    'blocks a GitHub all-check merge while an optional check is %s',
    async (optionalState) => {
      const sitter = definition('github')
      const snapshot = review('github', optionalState)
      const action = buildMergeAction(snapshot, sitter)
      if (!action || action.kind !== 'merge') {
        throw new Error('expected direct merge action')
      }
      mocks.loadGitHubState.mockResolvedValue(githubState(snapshot))

      await expect(
        executeGitHubSitterAction(
          sitter,
          action,
          git,
          undefined,
          createHostedReviewSitterMutationTracker(),
          vi.fn(async () => undefined)
        )
      ).rejects.toMatchObject({ reason: 'expected-state-mismatch' })
      expect(mocks.runGitHubApi).not.toHaveBeenCalled()
    }
  )

  it.each(['pending', 'failed'] as const)(
    'blocks a GitLab all-check merge while an optional check is %s',
    async (optionalState) => {
      const sitter = definition('gitlab')
      const snapshot = review('gitlab', optionalState)
      const action = buildMergeAction(snapshot, sitter)
      if (!action || action.kind !== 'merge') {
        throw new Error('expected direct merge action')
      }
      mocks.loadGitLabState.mockResolvedValue(gitlabState(snapshot))

      await expect(
        executeGitLabSitterAction(
          sitter,
          action,
          git,
          undefined,
          createHostedReviewSitterMutationTracker(),
          vi.fn(async () => undefined)
        )
      ).rejects.toMatchObject({ reason: 'expected-state-mismatch' })
      expect(mocks.runGitLabApi).not.toHaveBeenCalled()
    }
  )
})
