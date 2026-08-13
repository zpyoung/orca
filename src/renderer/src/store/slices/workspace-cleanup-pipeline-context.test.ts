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

  it('does not count or block on a pipeline tab whose run is unknown', async () => {
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
        pipelineRunsById: {}
      }),
      { applyDismissals: false }
    )

    expect(candidate.localContext.pipelineTabCount).toBe(0)
    expect(candidate.blockers).not.toContain('running-pipeline')
  })
})
