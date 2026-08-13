import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
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
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('clears the prior editor activeTabType instead of leaving it live when a pipeline tab is activated', async () => {
    const { useTabGroupWorkspaceModel } = await import('./useTabGroupWorkspaceModel')
    const model = useTabGroupWorkspaceModel({ groupId: 'group-1', worktreeId: 'wt-1' })

    model.commands.activateEditor('pipeline-tab-1')

    expect(mocks.setActiveFile).not.toHaveBeenCalled()
    // entityId is a run id — a stale activeTabType of 'editor' paired with the
    // previously active file id would misroute file-scoped actions (Cmd+S,
    // focus-zoom) at a file that is no longer visible, so the pipeline branch
    // must actively clear it rather than merely avoid writing 'pipeline'.
    expect(mocks.setActiveTabType).toHaveBeenCalledWith('terminal')
  })

  it('still routes a real editor tab through setActiveFile + activeTabType "editor"', async () => {
    const { useTabGroupWorkspaceModel } = await import('./useTabGroupWorkspaceModel')
    const model = useTabGroupWorkspaceModel({ groupId: 'group-1', worktreeId: 'wt-1' })

    model.commands.activateEditor('editor-tab-1')

    expect(mocks.setActiveFile).toHaveBeenCalledWith('/tmp/feature/src/main.ts')
    expect(mocks.setActiveTabType).toHaveBeenCalledWith('editor')
  })
})
