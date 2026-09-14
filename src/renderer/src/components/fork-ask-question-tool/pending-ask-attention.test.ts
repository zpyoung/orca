import { describe, expect, it } from 'vitest'
import type { AskStatus } from '../../../../shared/fork-ask-question-tool/ask-answer-envelope'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { resolveTerminalTabActivityStatus } from '../tab-bar/terminal-tab-activity-status'
import { selectTabHasPendingAsk, selectWorktreeHasPendingAsk } from './pending-ask-attention'

type AttentionState = Parameters<typeof selectWorktreeHasPendingAsk>[0]
const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

function stateWithAsk(status: AskStatus = 'registered', paneKey = PANE_KEY): AttentionState {
  return {
    pendingAsksByPaneKey: { [paneKey]: [{ status }] },
    tabsByWorktree: { workspace: [{ id: 'tab-1' }], other: [{ id: 'tab-10' }] }
  }
}

describe('pending ask attention', () => {
  it.each(['registered', 'pending'] as const)(
    'promotes %s asks on their owning tab and workspace',
    (status) => {
      const state = stateWithAsk(status)
      expect(selectTabHasPendingAsk(state, 'tab-1')).toBe(true)
      expect(selectWorktreeHasPendingAsk(state, 'workspace')).toBe(true)
      expect(selectTabHasPendingAsk(state, 'tab-10')).toBe(false)
      expect(selectWorktreeHasPendingAsk(state, 'other')).toBe(false)
      expect(selectWorktreeHasPendingAsk(state, 'missing')).toBe(false)
    }
  )

  it.each(['answered', 'partial', 'declined', 'timed_out', 'unavailable'] as const)(
    'clears immediately on %s while the resolved card remains queued',
    (status) => {
      const state = stateWithAsk(status)
      expect(selectTabHasPendingAsk(state, 'tab-1')).toBe(false)
      expect(selectWorktreeHasPendingAsk(state, 'workspace')).toBe(false)
    }
  )

  it('accepts legacy numeric pane suffixes', () => {
    const state = stateWithAsk('registered', 'tab-1:123')
    expect(selectTabHasPendingAsk(state, 'tab-1')).toBe(true)
    expect(selectWorktreeHasPendingAsk(state, 'workspace')).toBe(true)
  })

  it('finds a pending ask behind a terminal head and on another pane', () => {
    const state: AttentionState = {
      ...stateWithAsk('answered'),
      pendingAsksByPaneKey: {
        [PANE_KEY]: [{ status: 'answered' }],
        'tab-1:123': [{ status: 'declined' }, { status: 'registered' }]
      }
    }
    expect(selectTabHasPendingAsk(state, 'tab-1')).toBe(true)
    expect(selectWorktreeHasPendingAsk(state, 'workspace')).toBe(true)
  })

  it.each([{}, { tabsByWorktree: { workspace: [{ id: 'tab-1' }] } }, { pendingAsksByPaneKey: {} }])(
    'tolerates absent slices and empty queues',
    (state) => {
      expect(selectTabHasPendingAsk(state, 'tab-1')).toBe(false)
      expect(selectWorktreeHasPendingAsk(state, 'workspace')).toBe(false)
    }
  )

  it('requires workspace membership only for the workspace selector', () => {
    const state = { pendingAsksByPaneKey: { [PANE_KEY]: [{ status: 'registered' as const }] } }
    expect(selectTabHasPendingAsk(state, 'tab-1')).toBe(true)
    expect(selectWorktreeHasPendingAsk(state, 'workspace')).toBe(false)
  })

  it.each(['tab-1', 'tab-1:', 'tab-10:123', 'null', ':123'])(
    'ignores unattributed or nonmatching pane key %s',
    (paneKey) => {
      const state = stateWithAsk('registered', paneKey)
      expect(selectTabHasPendingAsk(state, 'tab-1')).toBe(false)
      expect(selectWorktreeHasPendingAsk(state, 'workspace')).toBe(false)
    }
  )

  it('ignores empty pane queues', () => {
    const state = { ...stateWithAsk(), pendingAsksByPaneKey: { [PANE_KEY]: [] } }
    expect(selectTabHasPendingAsk(state, 'tab-1')).toBe(false)
    expect(selectWorktreeHasPendingAsk(state, 'workspace')).toBe(false)
  })
})

describe('terminal tab pending ask status', () => {
  it('promotes an ask without hook or PTY evidence', () => {
    expect(
      resolveTerminalTabActivityStatus({
        tab: { id: 'tab-1', title: 'bash' },
        hasPendingAsk: true
      })
    ).toBe('permission')
  })

  it.each(['working', 'monitoring', 'interrupted', 'done'] as const)(
    'outranks %s and restores that status when the ask resolves',
    (state) => {
      const entry: AgentStatusEntry = {
        paneKey: PANE_KEY,
        state: state === 'monitoring' ? 'working' : state === 'interrupted' ? 'done' : state,
        workingMode: state === 'monitoring' ? 'monitoring' : undefined,
        interrupted: state === 'interrupted',
        prompt: '',
        updatedAt: Date.now(),
        stateStartedAt: Date.now(),
        stateHistory: [],
        agentType: 'codex'
      }
      const input = {
        tab: { id: 'tab-1', title: 'Codex' },
        agentStatusByPaneKey: { [PANE_KEY]: entry },
        ptyIdsByTabId: { 'tab-1': ['pty-1'] }
      }
      expect(resolveTerminalTabActivityStatus({ ...input, hasPendingAsk: true })).toBe('permission')
      expect(resolveTerminalTabActivityStatus({ ...input, hasPendingAsk: false })).toBe(state)
    }
  )
})
