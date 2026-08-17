import { describe, expect, it } from 'vitest'
import { enrichWorkspaceCleanupCandidates } from './workspace-cleanup'
import { WORKTREE_ID, makeCandidate, makeState } from './workspace-cleanup-slice-test-harness'

describe('workspace cleanup pipeline context', () => {
  it('treats a pipeline-only worktree as having visible context', async () => {
    const [candidate] = await enrichWorkspaceCleanupCandidates(
      [makeCandidate()],
      makeState({
        unifiedTabsByWorktree: {
          [WORKTREE_ID]: [
            {
              id: 'tab-1',
              entityId: 'run_abc',
              groupId: 'group-1',
              worktreeId: WORKTREE_ID,
              contentType: 'pipeline',
              label: 'bugfix-fast #1',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 0
            }
          ]
        },
        pipelineRunsById: {
          run_abc: {
            runId: 'run_abc',
            templateName: 'bugfix-fast',
            runNumber: 1,
            state: 'completed',
            workspaceId: WORKTREE_ID,
            lastSnapshotAt: null
          }
        }
      }),
      { applyDismissals: false }
    )

    expect(candidate.localContext.pipelineTabCount).toBe(1)
    expect(candidate.blockers).not.toContain('running-pipeline')
  })

  it('blocks cleanup while a pipeline run is still running', async () => {
    const [candidate] = await enrichWorkspaceCleanupCandidates(
      [makeCandidate()],
      makeState({
        unifiedTabsByWorktree: {
          [WORKTREE_ID]: [
            {
              id: 'tab-1',
              entityId: 'run_abc',
              groupId: 'group-1',
              worktreeId: WORKTREE_ID,
              contentType: 'pipeline',
              label: 'bugfix-fast #1',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 0
            }
          ]
        },
        pipelineRunsById: {
          run_abc: {
            runId: 'run_abc',
            templateName: 'bugfix-fast',
            runNumber: 1,
            state: 'running',
            workspaceId: WORKTREE_ID,
            lastSnapshotAt: null
          }
        }
      }),
      { applyDismissals: false }
    )

    expect(candidate.blockers).toContain('running-pipeline')
    expect(candidate.tier).toBe('protected')
  })

  it('does not count or block once hydrated confirms the run is genuinely gone', async () => {
    const [candidate] = await enrichWorkspaceCleanupCandidates(
      [makeCandidate()],
      makeState({
        unifiedTabsByWorktree: {
          [WORKTREE_ID]: [
            {
              id: 'tab-1',
              entityId: 'run_missing',
              groupId: 'group-1',
              worktreeId: WORKTREE_ID,
              contentType: 'pipeline',
              label: 'bugfix-fast #1',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 0
            }
          ]
        },
        pipelineRunHydrationByWorkspaceId: { [WORKTREE_ID]: { phase: 'hydrated' } },
        pipelineRunsById: {}
      }),
      { applyDismissals: false }
    )

    expect(candidate.localContext.pipelineTabCount).toBe(0)
    expect(candidate.blockers).not.toContain('running-pipeline')
  })

  it('counts and blocks a pipeline tab whose workspace hydration has never resolved', async () => {
    const [candidate] = await enrichWorkspaceCleanupCandidates(
      [makeCandidate()],
      makeState({
        unifiedTabsByWorktree: {
          [WORKTREE_ID]: [
            {
              id: 'tab-1',
              entityId: 'run_unknown',
              groupId: 'group-1',
              worktreeId: WORKTREE_ID,
              contentType: 'pipeline',
              label: 'bugfix-fast #1',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 0
            }
          ]
        },
        // no pipelineRunHydrationByWorkspaceId entry: hydration has not been
        // requested (or has not resolved) for this workspace yet.
        pipelineRunsById: {}
      }),
      { applyDismissals: false }
    )

    expect(candidate.localContext.pipelineTabCount).toBe(1)
    expect(candidate.blockers).toContain('running-pipeline')
  })

  it('counts but does not block an in-flight-hydration pipeline tab with a known non-running state', async () => {
    const [candidate] = await enrichWorkspaceCleanupCandidates(
      [makeCandidate()],
      makeState({
        unifiedTabsByWorktree: {
          [WORKTREE_ID]: [
            {
              id: 'tab-1',
              entityId: 'run_abc',
              groupId: 'group-1',
              worktreeId: WORKTREE_ID,
              contentType: 'pipeline',
              label: 'bugfix-fast #1',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 0
            }
          ]
        },
        pipelineRunHydrationByWorkspaceId: {
          [WORKTREE_ID]: { phase: 'in-flight', startedAt: 0, generation: 1 }
        },
        // a subscription snapshot can populate a run's state independently of
        // listRuns hydration (tech.md 3.4) — that known state is trusted.
        pipelineRunsById: {
          run_abc: {
            runId: 'run_abc',
            templateName: 'bugfix-fast',
            runNumber: 1,
            state: 'completed',
            workspaceId: WORKTREE_ID,
            lastSnapshotAt: null
          }
        }
      }),
      { applyDismissals: false }
    )

    expect(candidate.localContext.pipelineTabCount).toBe(1)
    expect(candidate.blockers).not.toContain('running-pipeline')
  })
})
