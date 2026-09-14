import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeListingHostScope } from '../../shared/runtime-listing-host-scope'
import type { HostedReviewSitterDefinition } from '../../shared/fork-hosted-review-sitter/types'

const worktreeIsClean = vi.fn(async () => true)

vi.mock('./provider-git', () => ({
  resolveHostedReviewSitterGitExecution: () => ({ worktreeIsClean })
}))

const { inspectHostedReviewSitterContention, inspectHostedReviewSitterOwnedSession } =
  await import('./contention')

const REPO_ID = 'repo-1'
const WORKTREE_PATH = '/workspaces/grampus'

const DEFINITION: HostedReviewSitterDefinition = {
  repoId: REPO_ID,
  worktreeId: `${REPO_ID}::${WORKTREE_PATH}`,
  repoPath: WORKTREE_PATH,
  branch: 'feature',
  provider: 'github',
  reviewNumber: 63,
  reviewUrl: 'https://github.com/example/repo/pull/63',
  capabilities: { updateBranch: 'on', resolveConflicts: 'on', fixChecks: 'on', merge: 'gated' },
  branchUpdateMode: 'merge-base-update',
  mergeMethod: 'squash'
}

// The repo row decides the sitter's execution host: a bare row is local, a `connectionId` is SSH.
function fakeStore(connectionId: string | null = null): Store {
  return {
    getRepo: (id: string) => (id === REPO_ID ? { id, connectionId } : undefined)
  } as unknown as Store
}

function fakeRuntime(hostScope: RuntimeListingHostScope | undefined, truncated = false) {
  return {
    showManagedWorktree: async () => ({
      repoId: REPO_ID,
      git: { path: WORKTREE_PATH }
    }),
    listTerminals: async () => ({ terminals: [], totalCount: 0, truncated, hostScope }),
    getTerminalAgentStatus: async () => ({ isRunningAgent: false, status: null })
  } as unknown as OrcaRuntimeService
}

describe('hosted review sitter terminal-census gate', () => {
  beforeEach(() => {
    worktreeIsClean.mockClear()
    worktreeIsClean.mockResolvedValue(true)
  })

  it('proceeds when the local execution host was covered and only unrelated hosts were disclosed', async () => {
    const contention = await inspectHostedReviewSitterContention(
      fakeRuntime({ hostIds: ['local'], omittedHostIds: ['ssh:box-1', 'runtime:env-1'] }),
      fakeStore(),
      DEFINITION
    )

    expect(contention).toEqual({ state: 'clear' })
  })

  it('holds when the listing never covered the SSH host the sitter executes on', async () => {
    const contention = await inspectHostedReviewSitterContention(
      fakeRuntime({ hostIds: ['local'], omittedHostIds: ['ssh:box-1'] }),
      fakeStore('box-1'),
      DEFINITION
    )

    expect(contention).toEqual({
      state: 'unverifiable',
      reason: 'terminal-host-census-incomplete'
    })
  })

  it('holds when the answering host reported no scope at all', async () => {
    const contention = await inspectHostedReviewSitterContention(
      fakeRuntime(undefined),
      fakeStore(),
      DEFINITION
    )

    expect(contention).toEqual({
      state: 'unverifiable',
      reason: 'terminal-host-census-incomplete'
    })
  })

  it('holds when the listing was truncated even though its host was covered', async () => {
    const contention = await inspectHostedReviewSitterContention(
      fakeRuntime({ hostIds: ['local'], omittedHostIds: [] }, true),
      fakeStore(),
      DEFINITION
    )

    expect(contention).toEqual({
      state: 'unverifiable',
      reason: 'terminal-host-census-incomplete'
    })
  })

  it('applies the same gate when reading an owned agent session', async () => {
    await expect(
      inspectHostedReviewSitterOwnedSession(
        fakeRuntime({ hostIds: ['local'], omittedHostIds: ['ssh:box-1'] }),
        fakeStore(),
        DEFINITION,
        'action-1'
      )
    ).resolves.toEqual({ state: 'absent' })

    await expect(
      inspectHostedReviewSitterOwnedSession(
        fakeRuntime({ hostIds: ['local'], omittedHostIds: ['ssh:box-1'] }),
        fakeStore('box-1'),
        DEFINITION,
        'action-1'
      )
    ).resolves.toEqual({ state: 'unverifiable', reason: 'terminal-host-census-incomplete' })
  })
})
