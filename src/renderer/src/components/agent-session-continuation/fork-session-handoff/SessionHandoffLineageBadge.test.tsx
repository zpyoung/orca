// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AgentStatusEntry } from '../../../../../shared/agent-status-types'
import type { ForkSessionHandoffLineageRecord } from '../../../../../shared/fork-session-handoff/session-lineage-types'
import { SessionHandoffLineageBadge } from './SessionHandoffLineageBadge'

const PARENT_LEAF = '11111111-1111-4111-8111-111111111111'
const CHILD_LEAF = '22222222-2222-4222-8222-222222222222'
const PARENT_PANE = `parent-tab:${PARENT_LEAF}`
const CHILD_PANE = `child-tab:${CHILD_LEAF}`

const harness = vi.hoisted(() => ({
  records: [] as ForkSessionHandoffLineageRecord[],
  state: {} as Record<string, unknown>,
  enrich: vi.fn(),
  activateFolderWorkspace: vi.fn(),
  activateWorktree: vi.fn(),
  activatePane: vi.fn()
}))

vi.mock('@/lib/fork-session-handoff/session-lineage-actions', () => ({
  enrichSessionLineage: harness.enrich,
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
  activateAndRevealFolderWorkspace: harness.activateFolderWorkspace,
  activateAndRevealWorktree: harness.activateWorktree
}))

vi.mock('@/lib/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: harness.activatePane
}))

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

function makeRecord(
  overrides: Partial<ForkSessionHandoffLineageRecord> = {}
): ForkSessionHandoffLineageRecord {
  return {
    id: 'lineage-1',
    createdAt: 1,
    relationship: 'continues',
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
    },
    ...overrides
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
    folderWorkspaces: [],
    worktreesByRepo: {
      repo: [worktree('parent-worktree'), worktree('child-worktree')]
    },
    setActiveTabType: vi.fn()
  }
}

function setTargetSurface(worktreeId: string, tabId: string): string {
  const paneKey = `${tabId}:${CHILD_LEAF}`
  harness.state.tabsByWorktree = {
    ...(harness.state.tabsByWorktree as Record<string, unknown>),
    [worktreeId]: [{ id: tabId }]
  }
  harness.state.terminalLayoutsByTabId = {
    ...(harness.state.terminalLayoutsByTabId as Record<string, unknown>),
    [tabId]: {
      root: { type: 'leaf', leafId: CHILD_LEAF },
      ptyIdsByLeafId: { [CHILD_LEAF]: `${tabId}-pty` }
    }
  }
  return paneKey
}

function renderBadge(paneKey = PARENT_PANE, parentClick = vi.fn()) {
  return {
    parentClick,
    ...render(
      <TooltipProvider>
        <div onClick={parentClick}>
          <SessionHandoffLineageBadge paneKey={paneKey} />
        </div>
      </TooltipProvider>
    )
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  harness.enrich.mockResolvedValue(undefined)
  harness.activateFolderWorkspace.mockReturnValue({})
  harness.activateWorktree.mockReturnValue({})
  resetState()
})

afterEach(cleanup)

describe('SessionHandoffLineageBadge', () => {
  it('matches a parent by pane key and safely activates its live child pane', async () => {
    const { parentClick } = renderBadge()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Jump to handed-off session' }))

    expect(harness.activateWorktree).toHaveBeenCalledWith('child-worktree')
    expect(harness.activatePane).toHaveBeenCalledWith('child-tab', CHILD_LEAF, {
      flashFocusedPane: true,
      scrollToBottomIfOutputSinceLastView: true
    })
    expect(parentClick).not.toHaveBeenCalled()
  })

  it('uses the persisted target pane key without requiring a current agent-status row', async () => {
    harness.state.agentStatusByPaneKey = {
      [PARENT_PANE]: statusEntry(PARENT_PANE, 'claude', 'parent-provider', 'parent-worktree')
    }

    renderBadge()
    const button = screen.getByRole('button', { name: 'Jump to handed-off session' })

    expect(button).toHaveAttribute('aria-disabled', 'false')
    await userEvent.setup().click(button)
    expect(harness.activateWorktree).toHaveBeenCalledWith('child-worktree')
    expect(harness.activatePane).toHaveBeenCalledWith('child-tab', CHILD_LEAF, {
      flashFocusedPane: true,
      scrollToBottomIfOutputSinceLastView: true
    })
  })

  it('resolves a provider identity from a retained pane', async () => {
    const retainedPane = setTargetSurface('child-worktree', 'retained-tab')
    harness.records = [
      makeRecord({
        child: { ...makeRecord().child, paneKey: `missing-tab:${CHILD_LEAF}` }
      })
    ]
    harness.state.agentStatusByPaneKey = {
      [PARENT_PANE]: statusEntry(PARENT_PANE, 'claude', 'parent-provider', 'parent-worktree')
    }
    harness.state.retainedAgentsByPaneKey = {
      [retainedPane]: {
        entry: statusEntry(retainedPane, 'codex', 'child-provider', 'child-worktree'),
        worktreeId: 'child-worktree',
        tab: { id: 'retained-tab' },
        agentType: 'codex',
        startedAt: 1
      }
    }

    renderBadge()
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Jump to handed-off session' }))

    expect(harness.activatePane).toHaveBeenCalledWith('retained-tab', CHILD_LEAF, {
      flashFocusedPane: true,
      scrollToBottomIfOutputSinceLastView: true
    })
  })

  it('resolves a provider identity from a sleeping pane', async () => {
    const sleepingPane = setTargetSurface('child-worktree', 'sleeping-tab')
    harness.records = [
      makeRecord({
        child: { ...makeRecord().child, paneKey: `missing-tab:${CHILD_LEAF}` }
      })
    ]
    harness.state.agentStatusByPaneKey = {
      [PARENT_PANE]: statusEntry(PARENT_PANE, 'claude', 'parent-provider', 'parent-worktree')
    }
    harness.state.sleepingAgentSessionsByPaneKey = {
      [sleepingPane]: {
        paneKey: sleepingPane,
        tabId: 'sleeping-tab',
        worktreeId: 'child-worktree',
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'child-provider' },
        prompt: '',
        state: 'done',
        capturedAt: 1,
        updatedAt: 1,
        origin: 'live'
      }
    }

    renderBadge()
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Jump to handed-off session' }))

    expect(harness.activatePane).toHaveBeenCalledWith('sleeping-tab', CHILD_LEAF, {
      flashFocusedPane: true,
      scrollToBottomIfOutputSinceLastView: true
    })
  })

  it('keeps a valid folder workspace live and activates it through the folder path', async () => {
    harness.records = [
      makeRecord({
        child: { ...makeRecord().child, worktreeId: 'folder:folder-1' }
      })
    ]
    harness.state.agentStatusByPaneKey = {
      [PARENT_PANE]: statusEntry(PARENT_PANE, 'claude', 'parent-provider', 'parent-worktree'),
      [CHILD_PANE]: statusEntry(CHILD_PANE, 'codex', 'child-provider', 'folder:folder-1')
    }
    setTargetSurface('folder:folder-1', 'child-tab')
    harness.state.folderWorkspaces = [{ id: 'folder-1' }]
    harness.state.worktreesByRepo = { repo: [worktree('parent-worktree')] }

    renderBadge()
    expect(screen.queryByText('worktree removed')).toBeNull()
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Jump to handed-off session' }))

    expect(harness.activateFolderWorkspace).toHaveBeenCalledWith('folder-1')
    expect(harness.activateWorktree).not.toHaveBeenCalled()
    expect(harness.activatePane).toHaveBeenCalledWith('child-tab', CHILD_LEAF, {
      flashFocusedPane: true,
      scrollToBottomIfOutputSinceLastView: true
    })
  })

  it('falls back to agent and provider-session identity when the pane key changed', () => {
    const replacementPane = `replacement-tab:${PARENT_LEAF}`
    harness.state.agentStatusByPaneKey = {
      [replacementPane]: statusEntry(
        replacementPane,
        'claude',
        'parent-provider',
        'parent-worktree'
      ),
      [CHILD_PANE]: statusEntry(CHILD_PANE, 'codex', 'child-provider', 'child-worktree')
    }

    renderBadge(replacementPane)

    expect(screen.getByTestId('session-handoff-lineage-badge')).toBeTruthy()
  })

  it('renders a tombstone and no click-through when the related worktree was removed', () => {
    harness.state.worktreesByRepo = { repo: [worktree('parent-worktree')] }

    renderBadge()

    expect(screen.getByText('worktree removed')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Jump to handed-off session' })).toBeNull()
  })

  it('keeps the tooltip on an aria-disabled click-through with no rendered pane', async () => {
    harness.state.agentStatusByPaneKey = {
      [PARENT_PANE]: statusEntry(PARENT_PANE, 'claude', 'parent-provider', 'parent-worktree')
    }
    harness.state.tabsByWorktree = {
      'parent-worktree': [{ id: 'parent-tab' }]
    }
    harness.state.terminalLayoutsByTabId = {
      'parent-tab': {
        root: { type: 'leaf', leafId: PARENT_LEAF },
        ptyIdsByLeafId: { [PARENT_LEAF]: 'parent-pty' }
      }
    }
    renderBadge()
    const user = userEvent.setup()
    const button = screen.getByRole('button', { name: 'Jump to handed-off session' })

    expect(button).toHaveAttribute('aria-disabled', 'true')
    await user.tab()
    expect(document.activeElement).toBe(button)
    expect((await screen.findAllByText('No live pane is available.')).length).toBeGreaterThan(0)
    await user.keyboard('{Enter}')
    expect(harness.activateWorktree).not.toHaveBeenCalled()
    expect(harness.activatePane).not.toHaveBeenCalled()
  })

  it('best-effort enriches a newly observed child identity from its launched tab', async () => {
    harness.records = [
      makeRecord({
        child: {
          ...makeRecord().child,
          paneKey: null,
          providerSessionId: null
        }
      })
    ]

    renderBadge(CHILD_PANE)

    await waitFor(() => {
      expect(harness.enrich).toHaveBeenCalledWith({
        recordId: 'lineage-1',
        paneKey: CHILD_PANE,
        providerSessionId: 'child-provider'
      })
    })
  })
})
