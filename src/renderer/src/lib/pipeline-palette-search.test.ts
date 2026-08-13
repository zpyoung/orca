import { describe, expect, it } from 'vitest'
import type { Tab, TabGroup, Worktree } from '../../../shared/types'
import type { PipelineRunSummary } from '@/store/slices/pipeline-runs'
import {
  PIPELINE_PALETTE_QUERY_MAX_BYTES,
  buildSearchablePipelineTabs,
  isPipelinePaletteQueryTooLarge,
  searchPipelineTabs,
  type SearchablePipelineTab
} from './pipeline-palette-search'

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    repoId: 'repo-1',
    path: '/tmp/wt-1',
    head: 'abc123',
    branch: 'refs/heads/feature/pipelines',
    isBare: false,
    isMainWorktree: false,
    displayName: 'Pipeline Worktree',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function makeTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 'pipe-1',
    entityId: 'run-1',
    groupId: 'group-1',
    worktreeId: 'wt-1',
    contentType: 'pipeline',
    label: 'Pipeline',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

function makeGroup(overrides: Partial<TabGroup> = {}): TabGroup {
  return {
    id: 'group-1',
    worktreeId: 'wt-1',
    activeTabId: 'pipe-1',
    tabOrder: ['pipe-1'],
    ...overrides
  }
}

function makeRun(overrides: Partial<PipelineRunSummary> = {}): PipelineRunSummary {
  return {
    runId: 'run-1',
    templateName: 'Deploy Staging',
    runNumber: 7,
    state: 'running',
    workspaceId: null,
    lastSnapshotAt: null,
    ...overrides
  }
}

describe('pipeline-palette-search', () => {
  it('keeps empty-query ordering deterministic and context-first', () => {
    const results = searchPipelineTabs(
      [
        {
          tab: makeTab({ id: 'pipe-other', worktreeId: 'wt-other' }),
          worktree: makeWorktree({ id: 'wt-other', displayName: 'Other WT' }),
          repoName: 'repo/other',
          worktreeSortIndex: 2,
          isCurrentTab: false,
          isCurrentWorktree: false,
          run: makeRun({ runId: 'run-other' })
        },
        {
          tab: makeTab({ id: 'pipe-current-worktree' }),
          worktree: makeWorktree({ displayName: 'Current WT' }),
          repoName: 'repo/current',
          worktreeSortIndex: 1,
          isCurrentTab: false,
          isCurrentWorktree: true,
          run: makeRun()
        },
        {
          tab: makeTab({ id: 'pipe-current-tab' }),
          worktree: makeWorktree({ displayName: 'Current WT' }),
          repoName: 'repo/current',
          worktreeSortIndex: 1,
          isCurrentTab: true,
          isCurrentWorktree: true,
          run: makeRun()
        }
      ],
      ''
    )

    expect(results.map((result) => result.tabId)).toEqual([
      'pipe-current-tab',
      'pipe-current-worktree',
      'pipe-other'
    ])
  })

  it('stamps each row with its own execution host when worktree ids collide', () => {
    const entries: SearchablePipelineTab[] = [
      {
        tab: makeTab({ id: 'pipe-local' }),
        worktree: makeWorktree(),
        repoName: 'repo/deploys',
        worktreeSortIndex: 0,
        isCurrentTab: false,
        isCurrentWorktree: false,
        run: makeRun()
      },
      {
        tab: makeTab({ id: 'pipe-remote' }),
        worktree: makeWorktree({ hostId: 'ssh:host-1' }),
        repoName: 'repo/deploys',
        worktreeSortIndex: 1,
        isCurrentTab: false,
        isCurrentWorktree: false,
        run: makeRun()
      }
    ]

    expect(
      searchPipelineTabs(entries, 'deploy').map((result) => [
        result.tabId,
        result.worktreeId,
        result.executionHostId
      ])
    ).toEqual([
      ['pipe-local', 'wt-1', undefined],
      ['pipe-remote', 'wt-1', 'ssh:host-1']
    ])
  })

  it('formats the row title as templateName #runNumber from the run summary', () => {
    const entries: SearchablePipelineTab[] = [
      {
        tab: makeTab(),
        worktree: makeWorktree(),
        repoName: 'repo/deploys',
        worktreeSortIndex: 0,
        isCurrentTab: false,
        isCurrentWorktree: false,
        run: makeRun({ templateName: 'Deploy Staging', runNumber: 7 })
      }
    ]

    expect(searchPipelineTabs(entries, '')[0]?.title).toBe('Deploy Staging #7')
  })

  it('falls back to the tab label without throwing when the run is absent from pipelineRunsById', () => {
    const entries: SearchablePipelineTab[] = [
      {
        tab: makeTab({ label: 'Stale Pipeline Tab' }),
        worktree: makeWorktree(),
        repoName: 'repo/deploys',
        worktreeSortIndex: 0,
        isCurrentTab: false,
        isCurrentWorktree: false,
        run: null
      }
    ]

    expect(() => searchPipelineTabs(entries, '')).not.toThrow()
    expect(searchPipelineTabs(entries, '')[0]?.title).toBe('Stale Pipeline Tab')
  })

  it('matches the pipeline type alias', () => {
    const entries: SearchablePipelineTab[] = [
      {
        tab: makeTab(),
        worktree: makeWorktree(),
        repoName: 'repo/deploys',
        worktreeSortIndex: 1,
        isCurrentTab: false,
        isCurrentWorktree: false,
        run: makeRun({ templateName: 'Deploy Staging', runNumber: 7 })
      }
    ]

    // Why no secondaryRange: type aliases match without a display secondary.
    // Why 'pipeline run': both aliases tie at start 0, and ties keep the first
    // (longer) alias so the fuller phrasing stays the label.
    const hit = searchPipelineTabs(entries, 'pipeline')[0]
    expect(hit?.secondaryRange).toBeNull()
    expect(hit?.typeAliasMatch).toEqual({ text: 'pipeline run', range: { start: 0, end: 8 } })
  })

  it('searches worktree and repo metadata', () => {
    const entries: SearchablePipelineTab[] = [
      {
        tab: makeTab(),
        worktree: makeWorktree({ displayName: 'Checkout Flow' }),
        repoName: 'orca/deploy-client',
        worktreeSortIndex: 1,
        isCurrentTab: false,
        isCurrentWorktree: false,
        run: makeRun({ templateName: 'Deploy Staging', runNumber: 7 })
      }
    ]

    expect(searchPipelineTabs(entries, 'checkout')[0]?.worktreeRange).toEqual({
      start: 0,
      end: 8
    })
    expect(searchPipelineTabs(entries, 'client')[0]?.repoRange).toEqual({ start: 12, end: 18 })
  })

  it('marks the current pipeline tab from the active unified group without gating on activeTabType', () => {
    const worktree = makeWorktree()
    const entries = buildSearchablePipelineTabs({
      worktrees: [worktree],
      repoMap: new Map([[worktree.repoId, { displayName: 'repo/deploys' }]]),
      worktreeOrder: new Map([[worktree.id, 0]]),
      unifiedTabsByWorktree: {
        [worktree.id]: [makeTab({ id: 'pipe-1', groupId: 'group-pipe' })]
      },
      activeGroupIdByWorktree: { [worktree.id]: 'group-pipe' },
      groupsByWorktree: {
        [worktree.id]: [makeGroup({ id: 'group-pipe', activeTabId: 'pipe-1' })]
      },
      activeWorktreeId: worktree.id,
      pipelineRunsById: { 'run-1': makeRun() }
    })

    expect(entries).toHaveLength(1)
    expect(entries[0].isCurrentTab).toBe(true)
    expect(entries[0].run).toEqual(makeRun())
    expect(searchPipelineTabs(entries, '')[0]?.score).toBe(-2)
  })

  it('builds a null run for a tab whose id is absent from pipelineRunsById', () => {
    const worktree = makeWorktree()
    const entries = buildSearchablePipelineTabs({
      worktrees: [worktree],
      repoMap: new Map([[worktree.repoId, { displayName: 'repo/deploys' }]]),
      worktreeOrder: new Map([[worktree.id, 0]]),
      unifiedTabsByWorktree: { [worktree.id]: [makeTab({ entityId: 'run-missing' })] },
      activeGroupIdByWorktree: {},
      groupsByWorktree: {},
      activeWorktreeId: null,
      pipelineRunsById: {}
    })

    expect(entries).toHaveLength(1)
    expect(entries[0].run).toBeNull()
  })

  it('excludes non-pipeline tabs from the same worktree', () => {
    const worktree = makeWorktree()
    const entries = buildSearchablePipelineTabs({
      worktrees: [worktree],
      repoMap: new Map(),
      worktreeOrder: new Map([[worktree.id, 0]]),
      unifiedTabsByWorktree: {
        [worktree.id]: [makeTab({ id: 'term-1', contentType: 'terminal' })]
      },
      activeGroupIdByWorktree: {},
      groupsByWorktree: {},
      activeWorktreeId: null,
      pipelineRunsById: {}
    })

    expect(entries).toHaveLength(0)
  })

  it('rejects oversized pasted queries before scanning pipeline tabs', () => {
    const oversizedQuery = 'secret-pipeline-palette'.repeat(PIPELINE_PALETTE_QUERY_MAX_BYTES)
    const entry = {
      get tab(): Tab {
        throw new Error('oversized pipeline palette queries must not scan tabs')
      },
      worktree: makeWorktree(),
      repoName: 'repo/deploys',
      worktreeSortIndex: 0,
      isCurrentTab: false,
      isCurrentWorktree: false,
      run: null
    } as SearchablePipelineTab

    expect(isPipelinePaletteQueryTooLarge(oversizedQuery)).toBe(true)
    expect(searchPipelineTabs([entry], oversizedQuery)).toEqual([])
  })

  it('lists a branch-less row on the empty query without throwing', () => {
    const entries: SearchablePipelineTab[] = [
      {
        tab: makeTab(),
        worktree: makeWorktree({
          displayName: undefined as unknown as string,
          branch: undefined as unknown as string,
          path: '/repos/deploy-review'
        }),
        repoName: 'orca',
        worktreeSortIndex: 0,
        isCurrentTab: false,
        isCurrentWorktree: false,
        run: null
      }
    ]

    expect(searchPipelineTabs(entries, '')[0]).toMatchObject({
      worktreeName: 'deploy-review',
      worktreeRange: null
    })
  })
})
