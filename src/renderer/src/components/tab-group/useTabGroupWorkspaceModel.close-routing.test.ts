import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  closeBrowserTab: vi.fn(),
  closeFile: vi.fn(),
  closeTab: vi.fn(),
  closeUnifiedTab: vi.fn()
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

vi.mock('../../store/slices/browser-webview-cleanup', () => ({
  destroyWorkspaceWebviews: vi.fn()
}))

vi.mock('../editor/editor-autosave', () => ({
  requestEditorFileClose: vi.fn()
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

vi.mock('../terminal/terminal-tab-actions', () => ({
  closeTerminalTab: vi.fn()
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => null
}))

function resetStore(): void {
  const pipelineTab = {
    id: 'pipeline-tab-1',
    entityId: 'run_abc',
    groupId: 'group-1',
    worktreeId: 'wt-1',
    contentType: 'pipeline',
    isPinned: false,
    label: 'bugfix-fast #1',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  const simulatorTab = {
    id: 'simulator-tab-1',
    entityId: 'sim_1',
    groupId: 'group-1',
    worktreeId: 'wt-1',
    contentType: 'simulator',
    isPinned: false,
    label: 'Simulator',
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
          activeTabId: null,
          tabOrder: [pipelineTab.id, simulatorTab.id]
        }
      ]
    },
    openFiles: [],
    reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 1 })),
    settings: { activeRuntimeEnvironmentId: null },
    tabsByWorktree: { 'wt-1': [] },
    terminalLayoutsByTabId: {},
    unifiedTabsByWorktree: { 'wt-1': [pipelineTab, simulatorTab] },
    closeBrowserTab: mocks.closeBrowserTab,
    closeFile: mocks.closeFile,
    closeTab: mocks.closeTab,
    closeUnifiedTab: mocks.closeUnifiedTab
  }
}

describe('useTabGroupWorkspaceModel close routing for non-editor unified tabs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStore()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('closes a single pipeline tab through closeUnifiedTab, never through the editor-close path', async () => {
    const { useTabGroupWorkspaceModel } = await import('./useTabGroupWorkspaceModel')
    const model = useTabGroupWorkspaceModel({ groupId: 'group-1', worktreeId: 'wt-1' })

    model.commands.closeItem('pipeline-tab-1')

    expect(mocks.closeUnifiedTab).toHaveBeenCalledWith('pipeline-tab-1')
    expect(mocks.closeFile).not.toHaveBeenCalled()
  })

  it('closes a single simulator tab through closeUnifiedTab, never through the editor-close path', async () => {
    const { useTabGroupWorkspaceModel } = await import('./useTabGroupWorkspaceModel')
    const model = useTabGroupWorkspaceModel({ groupId: 'group-1', worktreeId: 'wt-1' })

    model.commands.closeItem('simulator-tab-1')

    expect(mocks.closeUnifiedTab).toHaveBeenCalledWith('simulator-tab-1')
    expect(mocks.closeFile).not.toHaveBeenCalled()
  })

  it('bulk-closes a pipeline sibling through closeUnifiedTab, never through the editor-close path', async () => {
    const { useTabGroupWorkspaceModel } = await import('./useTabGroupWorkspaceModel')
    const model = useTabGroupWorkspaceModel({ groupId: 'group-1', worktreeId: 'wt-1' })

    // closeOthers('simulator-tab-1') routes its sibling (the pipeline tab) through closeMany
    model.commands.closeOthers('simulator-tab-1')

    expect(mocks.closeUnifiedTab).toHaveBeenCalledWith('pipeline-tab-1')
    expect(mocks.closeFile).not.toHaveBeenCalled()
  })
})
