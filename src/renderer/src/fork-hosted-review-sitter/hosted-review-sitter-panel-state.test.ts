import { describe, expect, it } from 'vitest'
import { WatcherListEntrySchema } from '../../../shared/fork-heimdall/watcher-types'
import { hostedReviewPayload } from './hosted-review-sitter-panel-state'

const legacyPayload = {
  branch: 'feature/review',
  provider: 'github',
  reviewNumber: 42,
  reviewUrl: 'https://github.com/acme/repo/pull/42',
  branchUpdateMode: 'merge-base-update',
  mergeMethod: null
}

function entry(kindPayload: unknown) {
  return WatcherListEntrySchema.parse({
    name: 'PR Sitter',
    enrollment: {
      watcherId: 'watcher-1',
      kind: 'hosted-review',
      workspaceKey: 'local::/repo/worktree',
      executionHostId: 'local',
      repoId: 'repo-1',
      worktreeId: 'worktree-1',
      workspacePath: '/repo/worktree',
      schedulerOwner: 'local_host_service',
      enabled: true,
      paused: false,
      commandRevision: 0,
      capabilities: {
        updateBranch: 'off',
        resolveConflicts: 'off',
        fixChecks: 'off',
        merge: 'off'
      },
      budget: { wallClockActiveMs: 3_600_000, turns: null },
      kindPayload,
      coordinatorIdentity: { handle: 'coordinator-1', paneKey: 'pane-1' },
      orchestrationRunId: null,
      createdAtMs: 1,
      terminalAtMs: null
    },
    status: {
      watcherId: 'watcher-1',
      enabled: true,
      state: 'watching',
      phase: 'watching',
      reason: null,
      parkReason: null,
      budget: { activeMs: 0, turns: 0, exhausted: null },
      startedAtMs: 1,
      lastSuccessfulTickAtMs: null,
      nextPulseAtMs: null
    }
  })
}

describe('hosted review panel payload guard', () => {
  it('normalizes legacy rows without a merge-check scope to all checks', () => {
    expect(hostedReviewPayload(entry(legacyPayload))?.mergeCheckScope).toBe('all')
  })

  it('preserves an explicit scope and rejects unknown scope values', () => {
    expect(
      hostedReviewPayload(entry({ ...legacyPayload, mergeCheckScope: 'required' }))?.mergeCheckScope
    ).toBe('required')
    expect(hostedReviewPayload(entry({ ...legacyPayload, mergeCheckScope: 'optional' }))).toBeNull()
  })
})
