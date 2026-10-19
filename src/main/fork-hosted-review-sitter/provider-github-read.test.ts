import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostedReviewSitterDefinition } from '../../shared/fork-hosted-review-sitter/types'
import type { HostedReviewSitterGitExecution } from './provider-git'
import { readGitHubSitterSnapshot } from './provider-github-read'

const mocks = vi.hoisted(() => ({
  ghExecFileAsync: vi.fn(),
  simulateConflicts: vi.fn()
}))

vi.mock('../github/gh-utils', () => ({
  acquire: vi.fn(async () => {}),
  release: vi.fn(),
  extractExecError: () => ({ stderr: '' }),
  ghExecFileAsync: mocks.ghExecFileAsync
}))
vi.mock('../github/client/lookup/pr-lookup-rate-limit', () => ({
  assertRateLimitBudget: vi.fn(async () => {})
}))
vi.mock('../github/rate-limit', () => ({ noteRepositoryRateLimitSpend: vi.fn() }))
vi.mock('../github/github-api-repository', () => ({
  githubHostExecOptions: () => ({}),
  resolveGitHubRepoExecution: vi.fn(async () => ({
    ownerRepo: { owner: 'acme', repo: 'widgets' },
    ghOptions: {}
  }))
}))
vi.mock('../source-control/hosted-review', () => ({ getHostedReviewForBranch: vi.fn() }))
vi.mock('../github/client', () => ({ getPRCheckDetails: vi.fn() }))

const HEAD = 'a'.repeat(40)
const RECORDED_BASE = 'b'.repeat(40)
const LIVE_BASE = 'c'.repeat(40)

const definition: HostedReviewSitterDefinition = {
  repoId: 'repo-1',
  worktreeId: 'worktree-1',
  repoPath: '/repo',
  branch: 'feature',
  provider: 'github',
  reviewNumber: 52,
  reviewUrl: 'https://github.com/acme/widgets/pull/52',
  capabilities: { updateBranch: 'on', resolveConflicts: 'on', fixChecks: 'on', merge: 'on' },
  branchUpdateMode: 'merge-base-update',
  mergeMethod: null,
  mergeCheckScope: 'all'
}

// The reader touches only the push target and conflict simulation; every other Git method stays unused.
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: readGitHubSitterSnapshot calls only reviewPushTarget and simulateConflicts.
const git = {
  reviewPushTarget: async () => ({ branchName: 'feature' }),
  simulateConflicts: mocks.simulateConflicts
} as unknown as HostedReviewSitterGitExecution

function pullRequestPayload(pullRequest: Record<string, unknown>): string {
  return JSON.stringify({
    data: {
      repository: {
        viewerDefaultMergeMethod: 'SQUASH',
        squashMergeAllowed: true,
        pullRequest: {
          id: 'PR_1',
          url: definition.reviewUrl,
          state: 'OPEN',
          merged: false,
          isDraft: false,
          headRefOid: HEAD,
          headRefName: 'feature',
          headRepository: { nameWithOwner: 'acme/widgets' },
          baseRefName: 'main',
          // github refreshes baseRefOid only on a push to the PR, so it lags the base branch
          baseRefOid: RECORDED_BASE,
          mergeStateStatus: 'DIRTY',
          isInMergeQueue: false,
          isMergeQueueEnabled: false,
          mergeQueueEntry: null,
          commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: null } }] },
          ...pullRequest
        }
      }
    }
  })
}

function respondWith(pullRequest: Record<string, unknown>): void {
  mocks.ghExecFileAsync.mockImplementation(async (args: string[]) => ({
    stdout: args.includes('graphql') ? pullRequestPayload(pullRequest) : '[]',
    stderr: ''
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.simulateConflicts.mockResolvedValue('present')
})

describe('GitHub sitter snapshot base SHA', () => {
  it('reports the base branch tip rather than the PR-recorded base commit', async () => {
    respondWith({ mergeable: 'CONFLICTING', baseRef: { target: { oid: LIVE_BASE } } })

    const snapshot = await readGitHubSitterSnapshot(definition, git, { fresh: true })

    expect(snapshot.baseSha).toBe(LIVE_BASE)
    expect(snapshot.conflicts).toBe('present')
  })

  it('simulates unknown mergeability against the base branch tip', async () => {
    respondWith({ mergeable: 'UNKNOWN', baseRef: { target: { oid: LIVE_BASE } } })

    await readGitHubSitterSnapshot(definition, git, { fresh: true })

    expect(mocks.simulateConflicts).toHaveBeenCalledWith(HEAD, LIVE_BASE, undefined)
  })

  it('leaves the base unknown instead of falling back to the stale recorded base', async () => {
    respondWith({ mergeable: 'CONFLICTING', baseRef: null })

    const snapshot = await readGitHubSitterSnapshot(definition, git, { fresh: true })

    expect(snapshot.baseSha).toBe('')
    expect(snapshot.providerReadiness.verdict).not.toBe('ready')
  })
})
