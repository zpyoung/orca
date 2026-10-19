import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildRerunAction } from '../../shared/fork-hosted-review-sitter/decision-action-builders'
import type {
  HostedReviewCheckSnapshot,
  HostedReviewSitterDefinition,
  HostedReviewSnapshot
} from '../../shared/fork-hosted-review-sitter/types'
import { createHostedReviewSitterMutationTracker } from './provider-action-effect'
import { executeGitHubSitterAction } from './provider-github-actions'
import type { GitHubState } from './provider-github-read'
import type { HostedReviewSitterGitExecution } from './provider-git'

const mocks = vi.hoisted(() => ({
  loadGitHubState: vi.fn(),
  runGitHubApi: vi.fn()
}))

vi.mock('./provider-github-read', () => ({
  ENQUEUE_PULL_REQUEST_MUTATION: 'mutation EnqueuePullRequest',
  loadGitHubState: mocks.loadGitHubState,
  runGitHubApi: mocks.runGitHubApi,
  stringValue: (value: unknown) => (typeof value === 'string' ? value : '')
}))

vi.mock('./provider-git', () => ({ throwIfAborted: vi.fn() }))

const HEAD = 'head-1'

function failedCheck(checkId: string, checkKey: string): HostedReviewCheckSnapshot {
  return {
    checkKey,
    checkId,
    name: checkKey,
    required: true,
    headSha: HEAD,
    state: 'failed',
    observationId: `${checkId}:1`,
    failureSignature: null
  }
}

function snapshot(checks: HostedReviewCheckSnapshot[]): HostedReviewSnapshot {
  return {
    provider: 'github',
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

const definition: HostedReviewSitterDefinition = {
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

function githubState(review: HostedReviewSnapshot): GitHubState {
  return {
    snapshot: review,
    ownerRepo: { owner: 'acme', repo: 'repo' },
    ghOptions: {},
    pullRequestId: 'pr-42',
    baseRefName: 'main',
    sourceIdentityComplete: true
  }
}

function ghFailure(stderr: string): Error {
  return Object.assign(new Error('Command failed: gh api'), { stderr })
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a rerun never touches a Git method.
const git = {} as unknown as HostedReviewSitterGitExecution

async function rerun(checks: HostedReviewCheckSnapshot[]) {
  const review = snapshot(checks)
  mocks.loadGitHubState.mockResolvedValue(githubState(review))
  const action = buildRerunAction(review, { checkKey: checks[0]!.checkKey, checks })
  return executeGitHubSitterAction(
    definition,
    action,
    git,
    undefined,
    createHostedReviewSitterMutationTracker(),
    async () => {}
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GitHub sitter check reruns', () => {
  it('reports a rerun refused because the workflow run is still going as landing nothing', async () => {
    mocks.runGitHubApi.mockRejectedValueOnce(
      ghFailure('gh: This workflow is already running (HTTP 403)\n')
    )

    await expect(rerun([failedCheck('workflow:900:check:1', 'test')])).rejects.toMatchObject({
      effect: 'not-landed',
      reason: 'workflow-run-in-progress'
    })
  })

  it('keeps the refusal indeterminate once an earlier workflow in the same action reran', async () => {
    mocks.runGitHubApi
      .mockResolvedValueOnce('')
      .mockRejectedValueOnce(ghFailure('gh: This workflow is already running (HTTP 403)\n'))

    const error: unknown = await rerun([
      failedCheck('workflow:900:check:1', 'test'),
      failedCheck('workflow:901:check:2', 'test')
    ]).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toHaveProperty('effect')
  })

  it('leaves other forbidden responses indeterminate', async () => {
    mocks.runGitHubApi.mockRejectedValueOnce(
      ghFailure('gh: Resource not accessible by integration (HTTP 403)\n')
    )

    const error: unknown = await rerun([failedCheck('workflow:900:check:1', 'test')]).catch(
      (caught: unknown) => caught
    )
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toHaveProperty('effect')
  })
})
