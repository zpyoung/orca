// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AgentStatusEntry } from '../../../../../shared/agent-status-types'
import type { AiVaultSession } from '../../../../../shared/ai-vault-types'
import type { ForkSessionHandoffLineageRecord } from '../../../../../shared/fork-session-handoff/session-lineage-types'
import { findAiVaultSessionLineage, ForkAiVaultLineageLine } from './ForkAiVaultLineageLine'

const PARENT_LEAF = '11111111-1111-4111-8111-111111111111'
const CHILD_LEAF = '22222222-2222-4222-8222-222222222222'
const PARENT_PANE = `parent-tab:${PARENT_LEAF}`
const CHILD_PANE = `child-tab:${CHILD_LEAF}`

const harness = vi.hoisted(() => ({
  records: [] as ForkSessionHandoffLineageRecord[],
  state: {} as Record<string, unknown>,
  activateWorktree: vi.fn(),
  activatePane: vi.fn()
}))

vi.mock('@/lib/fork-session-handoff/session-lineage-actions', () => ({
  enrichSessionLineage: vi.fn(),
  getSessionLineageSnapshot: () => harness.records,
  listSessionLineage: vi.fn().mockResolvedValue([]),
  subscribeSessionLineage: () => () => undefined
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(harness.state),
    { getState: () => harness.state }
  )
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: harness.activateWorktree
}))

vi.mock('@/lib/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: harness.activatePane
}))

const session = {
  id: 'vault-parent',
  executionHostId: 'local',
  agent: 'claude',
  sessionId: 'parent-provider',
  title: 'Parent session',
  cwd: '/tmp',
  branch: null,
  model: null,
  filePath: '/tmp/parent.jsonl',
  codexHome: null,
  createdAt: null,
  updatedAt: null,
  modifiedAt: '2026-08-24T00:00:00.000Z',
  messageCount: 1,
  totalTokens: 0,
  previewMessages: [],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: '',
  subagent: null
} satisfies AiVaultSession

function statusEntry(
  paneKey: string,
  agentType: 'claude' | 'codex',
  providerSessionId: string,
  worktreeId: string
): AgentStatusEntry {
  return {
    state: 'working',
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    paneKey,
    tabId: paneKey.slice(0, paneKey.indexOf(':')),
    worktreeId,
    agentType,
    stateHistory: [],
    providerSession: { key: 'session_id', id: providerSessionId }
  }
}

function makeRecord(): ForkSessionHandoffLineageRecord {
  return {
    id: 'lineage-1',
    createdAt: 1,
    relationship: 'reviews',
    parent: {
      paneKey: PARENT_PANE,
      agent: 'claude',
      providerSessionId: 'parent-provider',
      transcriptPath: '/tmp/parent.jsonl',
      worktreeId: 'parent-worktree',
      title: 'Parent session'
    },
    child: {
      paneKey: CHILD_PANE,
      agent: 'codex',
      providerSessionId: 'child-provider',
      transcriptPath: '/tmp/child.jsonl',
      worktreeId: 'child-worktree',
      title: 'Child session',
      tabId: 'child-tab'
    }
  }
}

function worktree(id: string) {
  return { id, repoId: 'repo', path: `/tmp/${id}` }
}

function resetState(): void {
  harness.records = [makeRecord()]
  harness.state = {
    agentStatusByPaneKey: {
      [PARENT_PANE]: statusEntry(PARENT_PANE, 'claude', 'parent-provider', 'parent-worktree'),
      [CHILD_PANE]: statusEntry(CHILD_PANE, 'codex', 'child-provider', 'child-worktree')
    },
    retainedAgentsByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    tabsByWorktree: {
      'parent-worktree': [{ id: 'parent-tab' }],
      'child-worktree': [{ id: 'child-tab' }]
    },
    terminalLayoutsByTabId: {
      'parent-tab': {
        root: { type: 'leaf', leafId: PARENT_LEAF },
        ptyIdsByLeafId: { [PARENT_LEAF]: 'parent-pty' }
      },
      'child-tab': {
        root: { type: 'leaf', leafId: CHILD_LEAF },
        ptyIdsByLeafId: { [CHILD_LEAF]: 'child-pty' }
      }
    },
    hasHydratedWorktreePurge: true,
    worktreesByRepo: {
      repo: [worktree('parent-worktree'), worktree('child-worktree')]
    },
    setActiveTabType: vi.fn()
  }
}

function renderLine(parentClick = vi.fn()) {
  return {
    parentClick,
    ...render(
      <TooltipProvider delayDuration={0}>
        <div onClick={parentClick}>
          <ForkAiVaultLineageLine session={session} />
        </div>
      </TooltipProvider>
    )
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  harness.activateWorktree.mockReturnValue({})
  resetState()
})

afterEach(cleanup)

describe('ForkAiVaultLineageLine', () => {
  it('matches vault identity and activates the related live pane without toggling the row', async () => {
    const { parentClick } = renderLine()

    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Jump to handed-off session' }))

    expect(screen.getByText('Handed off · reviews')).toBeTruthy()
    expect(harness.activateWorktree).toHaveBeenCalledWith('child-worktree')
    expect(harness.activatePane).toHaveBeenCalledWith('child-tab', CHILD_LEAF, {
      flashFocusedPane: true,
      scrollToBottomIfOutputSinceLastView: true
    })
    expect(parentClick).not.toHaveBeenCalled()
  })

  it('falls back to the transcript path when provider identity is unavailable', () => {
    const record = makeRecord()
    record.parent.providerSessionId = null

    const match = findAiVaultSessionLineage([record], session)

    expect(match?.side).toBe('parent')
    expect(match?.record.id).toBe(record.id)
  })

  it('renders a worktree tombstone instead of a link for a removed target', () => {
    harness.state.worktreesByRepo = { repo: [worktree('parent-worktree')] }

    renderLine()

    expect(screen.getByText('worktree removed')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Jump to handed-off session' })).toBeNull()
  })

  it('keeps unavailable click-through focusable and exposes its tooltip to the keyboard', async () => {
    harness.state.agentStatusByPaneKey = {
      [PARENT_PANE]: statusEntry(PARENT_PANE, 'claude', 'parent-provider', 'parent-worktree')
    }
    harness.state.tabsByWorktree = { 'parent-worktree': [{ id: 'parent-tab' }] }
    harness.state.terminalLayoutsByTabId = {
      'parent-tab': {
        root: { type: 'leaf', leafId: PARENT_LEAF },
        ptyIdsByLeafId: { [PARENT_LEAF]: 'parent-pty' }
      }
    }
    renderLine()
    const button = screen.getByRole('button', { name: 'Jump to handed-off session' })
    const user = userEvent.setup()

    expect(button).toHaveAttribute('aria-disabled', 'true')
    await user.tab()
    expect(document.activeElement).toBe(button)
    expect((await screen.findAllByText('No live pane is available.')).length).toBeGreaterThan(0)
    await user.keyboard('{Enter}')
    expect(harness.activateWorktree).not.toHaveBeenCalled()
  })
})
