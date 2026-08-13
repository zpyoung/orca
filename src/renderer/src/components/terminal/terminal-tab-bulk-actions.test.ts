import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getStateMock, isWebRuntimeSessionActiveMock } = vi.hoisted(() => ({
  getStateMock: vi.fn(),
  isWebRuntimeSessionActiveMock: vi.fn(() => false)
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: getStateMock }
}))

vi.mock('@/lib/terminal-worktree-route', () => ({
  hasUnroutableTerminalWorktreeOwner: vi.fn(() => false),
  resolveTerminalWorktreeRoute: vi.fn(() => ({ runtimeEnvironmentId: undefined }))
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  closeWebRuntimeSessionTab: vi.fn(),
  isWebRuntimeSessionActive: isWebRuntimeSessionActiveMock
}))

vi.mock('./close-local-terminal-tab-state', () => ({
  closeLocalTerminalTabState: vi.fn()
}))

import { closeTerminalTabsToRight } from './terminal-tab-bulk-actions'

function baseState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tabsByWorktree: { wt: [{ id: 't1' }] },
    openFiles: [],
    unifiedTabsByWorktree: {
      wt: [
        { id: 't1', entityId: 't1', contentType: 'terminal', isPinned: false },
        {
          id: 'p1',
          entityId: 'run_abc',
          contentType: 'pipeline',
          isPinned: false
        }
      ]
    },
    browserTabsByWorktree: {},
    tabBarOrderByWorktree: { wt: ['t1', 'p1'] },
    closeTab: vi.fn(),
    closeFile: vi.fn(),
    closeUnifiedTab: vi.fn(),
    ...overrides
  }
}

describe('closeTerminalTabsToRight', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isWebRuntimeSessionActiveMock.mockReturnValue(false)
  })

  it('closes a pipeline tab to the right via the generic unified-tab closer', () => {
    const state = baseState()
    getStateMock.mockReturnValue(state)

    closeTerminalTabsToRight('t1', 'wt')

    expect(state.closeUnifiedTab).toHaveBeenCalledWith('p1')
  })

  it('skips a pinned pipeline tab to the right', () => {
    const state = baseState({
      unifiedTabsByWorktree: {
        wt: [
          { id: 't1', entityId: 't1', contentType: 'terminal', isPinned: false },
          { id: 'p1', entityId: 'run_abc', contentType: 'pipeline', isPinned: true }
        ]
      }
    })
    getStateMock.mockReturnValue(state)

    closeTerminalTabsToRight('t1', 'wt')

    expect(state.closeUnifiedTab).not.toHaveBeenCalled()
  })
})
