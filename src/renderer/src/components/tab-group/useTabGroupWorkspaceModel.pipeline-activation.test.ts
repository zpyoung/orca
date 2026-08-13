import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  activatePipelineTabSurface: vi.fn(),
  activateTab: vi.fn(),
  focusGroup: vi.fn(),
  setActiveFile: vi.fn(),
  setActiveTab: vi.fn(),
  setActiveTabType: vi.fn()
}))

const storeBox = vi.hoisted(() => ({
  state: null as Record<string, unknown> | null
}))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    useCallback: <T>(callback: T) => callback,
    useMemo: <T>(factory: () => T) => factory()
  }
})

vi.mock('zustand/react/shallow', () => ({
  useShallow: <T>(selector: T) => selector
}))

vi.mock('../../store', () => {
  const useAppStore = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(storeBox.state ?? {}),
    {
      getState: () => storeBox.state ?? {}
    }
  )
  return { useAppStore }
})

vi.mock('../../store/selectors', () => ({
  useAllWorktrees: () => [{ id: 'wt-1', path: '/worktree' }]
}))

vi.mock('../../lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: vi.fn()
}))

vi.mock('../../runtime/web-runtime-session', () => ({
  activateWebRuntimeSessionTab: vi.fn(),
  closeWebRuntimeSessionTab: vi.fn(),
  createWebRuntimeSessionBrowserTab: vi.fn(),
  createWebRuntimeSessionTerminal: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(() => false)
}))

vi.mock('../../store/slices/browser-webview-cleanup', () => ({
  destroyWorkspaceWebviews: vi.fn()
}))

vi.mock('../../lib/create-untitled-markdown', () => ({
  createUntitledMarkdownFileWithTemplateSelection: vi.fn()
}))

vi.mock('../../lib/ipc-error', () => ({
  extractIpcErrorMessage: (_error: unknown, fallback: string) => fallback
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn() }
}))

function resetStore(): void {
  const editorFileTab = {
    id: 'editor-tab-1',
    entityId: '/tmp/feature/src/main.ts',
    groupId: 'group-1',
    worktreeId: 'wt-1',
    contentType: 'editor',
    label: 'main.ts',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  const pipelineTab = {
    id: 'pipeline-tab-1',
    entityId: 'run_abc',
    groupId: 'group-1',
    worktreeId: 'wt-1',
    contentType: 'pipeline',
    label: 'bugfix-fast #1',
    customLabel: null,
    color: null,
    sortOrder: 1,
    createdAt: 1
  }
  storeBox.state = {
    activeWorktreeId: 'wt-1',
    // Why: a terminal was active before the pipeline click — the regression this guards against
    // is this id surviving the click and letting a terminal-scoped action reach it.
    activeTabId: 'term-1',
    activeTabType: 'terminal',
    activeTabIdByWorktree: { 'wt-1': 'term-1' },
    activeTabTypeByWorktree: { 'wt-1': 'terminal' },
    browserTabsByWorktree: {},
    expandedPaneByTabId: {},
    groupsByWorktree: {
      'wt-1': [
        {
          id: 'group-1',
          worktreeId: 'wt-1',
          activeTabId: editorFileTab.id,
          tabOrder: [editorFileTab.id, pipelineTab.id]
        }
      ]
    },
    openFiles: [{ id: editorFileTab.entityId, worktreeId: 'wt-1' }],
    reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 2 })),
    settings: { activeRuntimeEnvironmentId: null },
    tabsByWorktree: { 'wt-1': [] },
    terminalLayoutsByTabId: {},
    unifiedTabsByWorktree: { 'wt-1': [editorFileTab, pipelineTab] },
    activatePipelineTabSurface: mocks.activatePipelineTabSurface,
    activateTab: mocks.activateTab,
    focusGroup: mocks.focusGroup,
    setActiveFile: mocks.setActiveFile,
    setActiveTab: mocks.setActiveTab,
    setActiveTabType: mocks.setActiveTabType
  }
}

describe('useTabGroupWorkspaceModel pipeline tab activation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStore()
    // Why: fakes the real store action's clearing behavior (verified separately in
    // tabs.test.ts) so this test can observe its effect on the mocked store surface.
    mocks.activatePipelineTabSurface.mockImplementation((worktreeId: string) => {
      if (!storeBox.state) {
        return
      }
      storeBox.state.activeTabId = null
      storeBox.state.activeTabType = 'terminal'
      storeBox.state.activeTabIdByWorktree = {
        ...(storeBox.state.activeTabIdByWorktree as Record<string, string | null>),
        [worktreeId]: null
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('routes pipeline tab activation through activatePipelineTabSurface instead of setActiveFile or setActiveTabType', async () => {
    const { useTabGroupWorkspaceModel } = await import('./useTabGroupWorkspaceModel')
    const model = useTabGroupWorkspaceModel({ groupId: 'group-1', worktreeId: 'wt-1' })

    model.commands.activateEditor('pipeline-tab-1')

    expect(mocks.setActiveFile).not.toHaveBeenCalled()
    expect(mocks.setActiveTabType).not.toHaveBeenCalled()
    expect(mocks.activatePipelineTabSurface).toHaveBeenCalledWith('wt-1')
  })

  it('clears the terminal that was active before the pipeline tab was focused, so a terminal-scoped action cannot reach it', async () => {
    const { useTabGroupWorkspaceModel } = await import('./useTabGroupWorkspaceModel')
    const model = useTabGroupWorkspaceModel({ groupId: 'group-1', worktreeId: 'wt-1' })
    expect(storeBox.state?.activeTabId).toBe('term-1')

    model.commands.activateEditor('pipeline-tab-1')

    expect(storeBox.state?.activeTabId).toBeNull()
    expect(storeBox.state?.activeTabIdByWorktree).toMatchObject({ 'wt-1': null })
  })

  it('still routes a real editor tab through setActiveFile + activeTabType "editor"', async () => {
    const { useTabGroupWorkspaceModel } = await import('./useTabGroupWorkspaceModel')
    const model = useTabGroupWorkspaceModel({ groupId: 'group-1', worktreeId: 'wt-1' })

    model.commands.activateEditor('editor-tab-1')

    expect(mocks.setActiveFile).toHaveBeenCalledWith('/tmp/feature/src/main.ts')
    expect(mocks.setActiveTabType).toHaveBeenCalledWith('editor')
  })
})
