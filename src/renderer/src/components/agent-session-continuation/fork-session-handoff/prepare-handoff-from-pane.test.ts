import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { prepareAgentSessionContinuationFromPane as prepareUpstreamAgentSessionContinuationFromPane } from '../../terminal-pane/terminal-agent-session-continuation'
import {
  isForkSessionHandoffRequest,
  prepareAgentSessionContinuationFromPane
} from './prepare-handoff-from-pane'

const { storeState } = vi.hoisted(() => ({
  storeState: {
    marker: 'state',
    agentStatusByPaneKey: {
      'tab-1:11111111-1111-4111-8111-111111111111': {
        providerSession: { key: 'session_id', id: 'provider-session-1' }
      }
    }
  }
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => storeState } }))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: vi.fn(() => 'ssh:dev-box')
}))
vi.mock('../../terminal-pane/terminal-agent-session-continuation', () => ({
  prepareAgentSessionContinuationFromPane: vi.fn()
}))

const upstreamRequest = {
  source: { capturedText: '', sourceAgent: 'claude' as const },
  worktreeId: 'repo::/worktree',
  groupId: 'group-1',
  workspacePath: '/worktree',
  initialCwd: '/worktree',
  launchSource: 'terminal_context_menu' as const
}

function makePane(): ManagedPane {
  return {
    leafId: '11111111-1111-4111-8111-111111111111',
    serializeAddon: { serialize: vi.fn(() => 'latest scrollback') }
  } as unknown as ManagedPane
}

describe('prepareAgentSessionContinuationFromPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prepareUpstreamAgentSessionContinuationFromPane).mockReturnValue(upstreamRequest)
  })

  it('wraps the upstream capture and adds pane and host identity', () => {
    const pane = makePane()
    const result = prepareAgentSessionContinuationFromPane({
      pane,
      tabId: 'tab-1',
      worktreeId: 'repo::/worktree',
      groupId: 'group-1',
      workspacePath: '/worktree',
      initialCwd: '/worktree'
    })

    expect(prepareUpstreamAgentSessionContinuationFromPane).toHaveBeenCalledOnce()
    expect(getExecutionHostIdForWorktree).toHaveBeenCalledWith(storeState, 'repo::/worktree')
    expect(result?.forkSource).toMatchObject({
      sourcePaneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
      sourceWorktreeId: 'repo::/worktree',
      anchorWorktreeId: 'repo::/worktree',
      sourceExecutionHostId: 'ssh:dev-box',
      providerSessionId: 'provider-session-1',
      vaultSessionId: null,
      vaultAgent: null
    })
    expect(result?.forkSource?.capturePaneScrollback?.()).toBe('latest scrollback')
    expect(pane.serializeAddon.serialize).toHaveBeenCalledWith({ scrollback: 800 })
    expect(result && isForkSessionHandoffRequest(result)).toBe(true)
  })

  it('passes an upstream null through without deriving fork fields', () => {
    vi.mocked(prepareUpstreamAgentSessionContinuationFromPane).mockReturnValue(null)

    const result = prepareAgentSessionContinuationFromPane({
      pane: makePane(),
      tabId: 'tab-1',
      worktreeId: 'repo::/worktree',
      groupId: null,
      workspacePath: '/worktree',
      initialCwd: '/worktree'
    })

    expect(result).toBeNull()
    expect(getExecutionHostIdForWorktree).not.toHaveBeenCalled()
  })
})
