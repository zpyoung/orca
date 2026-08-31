import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../../shared/agent-status-types'
import { getFocusedSessionBindingKey, resolveFocusedSession } from './focused-session-info'

const ACTIVE_LEAF = '00000000-0000-4000-8000-000000000001'
const SIBLING_LEAF = '00000000-0000-4000-8000-000000000002'
const ACTIVE_KEY = `tab-1:${ACTIVE_LEAF}`

function status(paneKey: string): AgentStatusEntry {
  return {
    paneKey,
    state: 'working',
    prompt: '',
    updatedAt: 2,
    stateStartedAt: 1,
    stateHistory: []
  } as AgentStatusEntry
}

function state(
  overrides: Record<string, unknown> = {}
): Parameters<typeof resolveFocusedSession>[0] {
  return {
    activeTabId: 'tab-1',
    activeTabType: 'terminal',
    activeWorktreeId: 'worktree-1',
    tabsByWorktree: {
      'worktree-1': [{ id: 'tab-1' }]
    },
    agentStatusByPaneKey: {
      [ACTIVE_KEY]: status(ACTIVE_KEY),
      [`tab-1:${SIBLING_LEAF}`]: status(`tab-1:${SIBLING_LEAF}`)
    },
    folderWorkspaces: [],
    // upstream routes an unknown worktree id to local regardless of settings, so the
    // fixture must publish the repo the id derives from for runtime ownership to resolve
    repos: [{ id: 'worktree-1' }],
    settings: { activeRuntimeEnvironmentId: null },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: null,
        activeLeafId: ACTIVE_LEAF,
        expandedLeafId: null,
        titlesByLeafId: { [ACTIVE_LEAF]: 'Focused pane' }
      }
    },
    getKnownWorktreeById: () => ({
      id: 'worktree-1',
      displayName: 'Workspace',
      path: '/workspace'
    }),
    ...overrides
  } as unknown as Parameters<typeof resolveFocusedSession>[0]
}

describe('resolveFocusedSession', () => {
  it('selects only the active split leaf', () => {
    const selected = resolveFocusedSession(state())
    expect(selected.paneKey).toBe(ACTIVE_KEY)
    expect(selected.status?.paneKey).toBe(ACTIVE_KEY)
    expect(selected.paneLabel).toBe('Focused pane')
  })

  it('does not fall back to a sibling or retained session', () => {
    const selected = resolveFocusedSession(
      state({
        agentStatusByPaneKey: { [`tab-1:${SIBLING_LEAF}`]: status(`tab-1:${SIBLING_LEAF}`) }
      })
    )
    expect(selected.paneKey).toBe(ACTIVE_KEY)
    expect(selected.status).toBeNull()
  })

  it('keeps the binding stable across state transitions in one session', () => {
    const entry: AgentStatusEntry = {
      ...status(ACTIVE_KEY),
      stateStartedAt: 20,
      stateHistory: [{ state: 'working', prompt: '', startedAt: 10 }]
    }
    const initial = getFocusedSessionBindingKey(ACTIVE_KEY, entry)
    expect(getFocusedSessionBindingKey(ACTIVE_KEY, { ...entry, stateStartedAt: 30 })).toBe(initial)
  })

  it('marks a WSL-owned workspace as non-local execution', () => {
    const selected = resolveFocusedSession(
      state({
        getKnownWorktreeById: () => ({
          id: 'worktree-1',
          displayName: 'Workspace',
          path: String.raw`\\wsl.localhost\Ubuntu\workspace`
        })
      })
    )
    expect(selected.wslDistro).toBe('Ubuntu')
    expect(selected.isLocalExecution).toBe(false)
  })

  it('marks active runtime environments as non-local execution', () => {
    expect(
      resolveFocusedSession(state({ settings: { activeRuntimeEnvironmentId: 'runtime-1' } }))
        .isLocalExecution
    ).toBe(false)
  })

  it('rejects a stale terminal selection while another surface is focused', () => {
    expect(resolveFocusedSession(state({ activeTabType: 'editor' })).paneKey).toBeNull()
    expect(
      resolveFocusedSession(state({ tabsByWorktree: { 'worktree-1': [] } })).paneKey
    ).toBeNull()
  })

  it('rejects a non-stable active leaf', () => {
    const selected = resolveFocusedSession(
      state({
        terminalLayoutsByTabId: {
          'tab-1': { root: null, activeLeafId: '1', expandedLeafId: null }
        }
      })
    )
    expect(selected.paneKey).toBeNull()
    expect(selected.status).toBeNull()
  })
})
