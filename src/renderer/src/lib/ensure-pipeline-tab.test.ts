import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockStoreState = vi.hoisted(() => ({
  activeGroupIdByWorktree: {} as Record<string, string>,
  activeWorktreeId: 'wt-1',
  activateTab: vi.fn(),
  createUnifiedTab: vi.fn(),
  focusGroup: vi.fn(),
  seedPipelineRunWorkspace: vi.fn(),
  groupsByWorktree: {} as Record<string, { id: string }[]>,
  unifiedTabsByWorktree: {} as Record<
    string,
    { id: string; groupId: string; contentType: string; entityId: string }[]
  >
}))

const activateAndRevealWorkspaceMock = vi.hoisted(() => vi.fn())

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState
  }
}))

vi.mock('./worktree-activation', () => ({
  activateAndRevealWorkspace: activateAndRevealWorkspaceMock
}))

describe('ensurePipelineTab', () => {
  beforeEach(() => {
    mockStoreState.activeGroupIdByWorktree = { 'wt-1': 'group-1' }
    mockStoreState.activeWorktreeId = 'wt-1'
    mockStoreState.groupsByWorktree = { 'wt-1': [{ id: 'group-1' }] }
    mockStoreState.unifiedTabsByWorktree = { 'wt-1': [] }
    mockStoreState.activateTab.mockReset()
    mockStoreState.createUnifiedTab.mockReset()
    mockStoreState.focusGroup.mockReset()
    mockStoreState.seedPipelineRunWorkspace.mockReset()
    // default to a successful reveal; individual tests override to simulate failure
    activateAndRevealWorkspaceMock.mockReset().mockReturnValue({ primaryTabId: null })
    vi.resetModules()
  })

  it('creates a pipeline tab keyed by run id and surfaces it', async () => {
    mockStoreState.createUnifiedTab.mockReturnValue({
      id: 'tab-1',
      groupId: 'group-1',
      contentType: 'pipeline',
      entityId: 'run-1'
    })
    const { ensurePipelineTab } = await import('./ensure-pipeline-tab')

    const result = ensurePipelineTab('wt-1', {
      runId: 'run-1',
      runNumber: 3,
      templateName: 'bugfix-fast'
    })

    expect(result).toBe('tab-1')
    expect(mockStoreState.createUnifiedTab).toHaveBeenCalledWith('wt-1', 'pipeline', {
      entityId: 'run-1',
      label: 'bugfix-fast #3',
      targetGroupId: 'group-1',
      activate: true
    })
    expect(mockStoreState.activateTab).toHaveBeenCalledWith('tab-1')
    expect(mockStoreState.focusGroup).toHaveBeenCalledWith('wt-1', 'group-1')
  })

  it("seeds the run's owning workspace before a group is even resolved, so a canvas mounted from this call already knows its host", async () => {
    mockStoreState.createUnifiedTab.mockReturnValue({
      id: 'tab-1',
      groupId: 'group-1',
      contentType: 'pipeline',
      entityId: 'run-1'
    })
    const { ensurePipelineTab } = await import('./ensure-pipeline-tab')

    ensurePipelineTab('wt-1', { runId: 'run-1', runNumber: 3, templateName: 'bugfix-fast' })

    expect(mockStoreState.seedPipelineRunWorkspace).toHaveBeenCalledWith({
      runId: 'run-1',
      workspaceId: 'wt-1',
      templateName: 'bugfix-fast',
      runNumber: 3
    })
  })

  it('reuses the existing tab for the same run id instead of creating a duplicate', async () => {
    mockStoreState.unifiedTabsByWorktree = {
      'wt-1': [
        { id: 'tab-existing', groupId: 'group-1', contentType: 'pipeline', entityId: 'run-1' }
      ]
    }
    const { ensurePipelineTab } = await import('./ensure-pipeline-tab')

    const result = ensurePipelineTab('wt-1', {
      runId: 'run-1',
      runNumber: 3,
      templateName: 'bugfix-fast'
    })

    expect(result).toBe('tab-existing')
    expect(mockStoreState.createUnifiedTab).not.toHaveBeenCalled()
    expect(mockStoreState.activateTab).toHaveBeenCalledWith('tab-existing')
    expect(mockStoreState.focusGroup).toHaveBeenCalledWith('wt-1', 'group-1')
  })

  it('creates a second tab for a different run id in the same workspace', async () => {
    mockStoreState.unifiedTabsByWorktree = {
      'wt-1': [
        { id: 'tab-existing', groupId: 'group-1', contentType: 'pipeline', entityId: 'run-1' }
      ]
    }
    mockStoreState.createUnifiedTab.mockReturnValue({
      id: 'tab-2',
      groupId: 'group-1',
      contentType: 'pipeline',
      entityId: 'run-2'
    })
    const { ensurePipelineTab } = await import('./ensure-pipeline-tab')

    const result = ensurePipelineTab('wt-1', {
      runId: 'run-2',
      runNumber: 4,
      templateName: 'bugfix-fast'
    })

    expect(result).toBe('tab-2')
    expect(mockStoreState.createUnifiedTab).toHaveBeenCalledWith('wt-1', 'pipeline', {
      entityId: 'run-2',
      label: 'bugfix-fast #4',
      targetGroupId: 'group-1',
      activate: true
    })
  })

  it('does not activate or focus when surfacePane is false', async () => {
    mockStoreState.createUnifiedTab.mockReturnValue({
      id: 'tab-3',
      groupId: 'group-1',
      contentType: 'pipeline',
      entityId: 'run-3'
    })
    const { ensurePipelineTab } = await import('./ensure-pipeline-tab')

    const result = ensurePipelineTab(
      'wt-1',
      { runId: 'run-3', runNumber: 1, templateName: 'bugfix-fast' },
      { surfacePane: false }
    )

    expect(result).toBe('tab-3')
    expect(mockStoreState.createUnifiedTab).toHaveBeenCalledWith('wt-1', 'pipeline', {
      entityId: 'run-3',
      label: 'bugfix-fast #1',
      targetGroupId: 'group-1',
      activate: false
    })
    expect(mockStoreState.activateTab).not.toHaveBeenCalled()
    expect(mockStoreState.focusGroup).not.toHaveBeenCalled()
  })

  it('switches to the owning workspace of a reused tab when a different workspace is active, instead of updating hidden state', async () => {
    mockStoreState.activeWorktreeId = 'wt-other'
    mockStoreState.groupsByWorktree = {
      'wt-1': [{ id: 'group-1' }],
      'wt-other': [{ id: 'group-other' }]
    }
    mockStoreState.activeGroupIdByWorktree = { 'wt-1': 'group-1', 'wt-other': 'group-other' }
    mockStoreState.unifiedTabsByWorktree = {
      'wt-1': [
        { id: 'tab-existing', groupId: 'group-1', contentType: 'pipeline', entityId: 'run-1' }
      ]
    }
    const { ensurePipelineTab } = await import('./ensure-pipeline-tab')

    const result = ensurePipelineTab('wt-1', {
      runId: 'run-1',
      runNumber: 3,
      templateName: 'bugfix-fast'
    })

    expect(result).toBe('tab-existing')
    expect(activateAndRevealWorkspaceMock).toHaveBeenCalledWith('wt-1')
    expect(mockStoreState.activateTab).toHaveBeenCalledWith('tab-existing')
    expect(mockStoreState.focusGroup).toHaveBeenCalledWith('wt-1', 'group-1')
  })

  it('switches to the owning workspace of a newly created tab when a different workspace is active', async () => {
    mockStoreState.activeWorktreeId = 'wt-other'
    mockStoreState.groupsByWorktree = {
      'wt-1': [{ id: 'group-1' }],
      'wt-other': [{ id: 'group-other' }]
    }
    mockStoreState.activeGroupIdByWorktree = { 'wt-1': 'group-1', 'wt-other': 'group-other' }
    mockStoreState.createUnifiedTab.mockReturnValue({
      id: 'tab-4',
      groupId: 'group-1',
      contentType: 'pipeline',
      entityId: 'run-4'
    })
    const { ensurePipelineTab } = await import('./ensure-pipeline-tab')

    ensurePipelineTab('wt-1', { runId: 'run-4', runNumber: 5, templateName: 'bugfix-fast' })

    expect(activateAndRevealWorkspaceMock).toHaveBeenCalledWith('wt-1')
    expect(mockStoreState.activateTab).toHaveBeenCalledWith('tab-4')
    expect(mockStoreState.focusGroup).toHaveBeenCalledWith('wt-1', 'group-1')
  })

  it('does not switch workspaces when surfacePane is false, even for a different active workspace', async () => {
    mockStoreState.activeWorktreeId = 'wt-other'
    mockStoreState.groupsByWorktree = {
      'wt-1': [{ id: 'group-1' }],
      'wt-other': [{ id: 'group-other' }]
    }
    mockStoreState.activeGroupIdByWorktree = { 'wt-1': 'group-1', 'wt-other': 'group-other' }
    mockStoreState.createUnifiedTab.mockReturnValue({
      id: 'tab-5',
      groupId: 'group-1',
      contentType: 'pipeline',
      entityId: 'run-5'
    })
    const { ensurePipelineTab } = await import('./ensure-pipeline-tab')

    ensurePipelineTab(
      'wt-1',
      { runId: 'run-5', runNumber: 6, templateName: 'bugfix-fast' },
      { surfacePane: false }
    )

    expect(activateAndRevealWorkspaceMock).not.toHaveBeenCalled()
    expect(mockStoreState.activateTab).not.toHaveBeenCalled()
  })

  it('does not switch workspaces when the target is already active', async () => {
    mockStoreState.unifiedTabsByWorktree = {
      'wt-1': [
        { id: 'tab-existing', groupId: 'group-1', contentType: 'pipeline', entityId: 'run-1' }
      ]
    }
    const { ensurePipelineTab } = await import('./ensure-pipeline-tab')

    ensurePipelineTab('wt-1', { runId: 'run-1', runNumber: 3, templateName: 'bugfix-fast' })

    expect(activateAndRevealWorkspaceMock).not.toHaveBeenCalled()
    expect(mockStoreState.activateTab).toHaveBeenCalledWith('tab-existing')
  })

  it('returns null and skips tab bookkeeping when the workspace switch itself fails', async () => {
    mockStoreState.activeWorktreeId = 'wt-other'
    mockStoreState.groupsByWorktree = {
      'wt-1': [{ id: 'group-1' }],
      'wt-other': [{ id: 'group-other' }]
    }
    mockStoreState.activeGroupIdByWorktree = { 'wt-1': 'group-1', 'wt-other': 'group-other' }
    // e.g. a disconnected SSH host or an unmounted folder path
    activateAndRevealWorkspaceMock.mockReturnValue(false)
    const { ensurePipelineTab } = await import('./ensure-pipeline-tab')

    const result = ensurePipelineTab('wt-1', {
      runId: 'run-1',
      runNumber: 3,
      templateName: 'bugfix-fast'
    })

    expect(result).toBeNull()
    expect(mockStoreState.createUnifiedTab).not.toHaveBeenCalled()
    expect(mockStoreState.activateTab).not.toHaveBeenCalled()
  })

  it('returns null when the workspace has no group to host the tab', async () => {
    mockStoreState.activeGroupIdByWorktree = {}
    mockStoreState.groupsByWorktree = { 'wt-1': [] }
    const { ensurePipelineTab } = await import('./ensure-pipeline-tab')

    const result = ensurePipelineTab('wt-1', {
      runId: 'run-1',
      runNumber: 1,
      templateName: 'bugfix-fast'
    })

    expect(result).toBeNull()
    expect(mockStoreState.createUnifiedTab).not.toHaveBeenCalled()
  })
})

describe('canEnsurePipelineTab', () => {
  beforeEach(() => {
    mockStoreState.activeGroupIdByWorktree = { 'wt-1': 'group-1' }
    mockStoreState.groupsByWorktree = { 'wt-1': [{ id: 'group-1' }] }
  })

  it('is true when the workspace has a group to host a pipeline canvas', async () => {
    const { canEnsurePipelineTab } = await import('./ensure-pipeline-tab')
    expect(canEnsurePipelineTab('wt-1')).toBe(true)
  })

  // Regression (R6): a run-history row for a deleted workspace must be recognizable as
  // inert instead of silently no-opping on click — this is the precondition ensurePipelineTab
  // itself checks, exposed so callers can decide up front rather than discover it by failing.
  it('is false for a workspace that no longer has any group — e.g. a deleted workspace', async () => {
    mockStoreState.activeGroupIdByWorktree = {}
    mockStoreState.groupsByWorktree = {}
    const { canEnsurePipelineTab } = await import('./ensure-pipeline-tab')
    expect(canEnsurePipelineTab('wt-deleted')).toBe(false)
  })
})
