// @vitest-environment happy-dom
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { useWorktreeActivityStatus } from '../sidebar/use-worktree-activity-status'
import { selectWorktreeActivityStatuses } from '../sidebar/use-worktree-activity-statuses'
import type { AskCardModel } from '../../store/slices/fork-ask-question-tool/asks'
import {
  PaletteLiveStatusProvider,
  PaletteRecentTabStatusDot,
  PaletteWorktreeStatusDot
} from '../cmd-j/palette-live-status'
import { shouldIncludeOpenTabInRecentSection } from '../worktree-jump-palette-recent-inclusion'
import { usePendingAskTabIds } from './use-pending-ask-tab-ids'
import { getWorktreeStatusLabel } from '@/lib/worktree-status'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { OpenTabPaletteItem, OpenTabRecentRow } from '../worktree-jump-palette-model'
import type { Worktree } from '../../../../shared/worktree/types'

const PANE_KEY = 'tab-1:123'
const initialState = useAppStore.getState()
const tab: TerminalTab = {
  id: 'tab-1',
  worktreeId: 'folder-workspace',
  ptyId: null,
  title: 'bash',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 0
}

function card(status: AskCardModel['status']): AskCardModel {
  return { askId: 'ask-1', paneKey: PANE_KEY, status, spec: null, partial: {} }
}

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

describe('pending ask workspace surfaces', () => {
  it('updates the sidebar hook and parent picker when an ask arrives and resolves', () => {
    useAppStore.setState({
      tabsByWorktree: { 'folder-workspace': [tab] },
      browserTabsByWorktree: {},
      runtimePaneTitlesByTabId: {},
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {},
      agentStatusEpoch: 0,
      agentStatusByPaneKey: {},
      migrationUnsupportedByPtyId: {},
      retainedAgentsByPaneKey: {},
      runtimeAgentOrchestrationByPaneKey: {},
      pendingAsksByPaneKey: {}
    })
    const { result } = renderHook(() => useWorktreeActivityStatus('folder-workspace'))
    const baseline = result.current
    const pickerStatuses = () =>
      selectWorktreeActivityStatuses(useAppStore.getState(), ['folder-workspace', 'other'])
    const otherBaseline = pickerStatuses().get('other')

    act(() => {
      useAppStore.setState({ pendingAsksByPaneKey: { [PANE_KEY]: [card('registered')] } })
    })
    expect(result.current).toBe('permission')
    expect(pickerStatuses().get('folder-workspace')).toBe('permission')
    expect(pickerStatuses().get('other')).toBe(otherBaseline)

    act(() => {
      useAppStore.setState({ pendingAsksByPaneKey: { [PANE_KEY]: [card('answered')] } })
    })
    expect(result.current).toBe(baseline)
    expect(pickerStatuses().get('folder-workspace')).toBe(baseline)
    expect(useAppStore.getState().pendingAsksByPaneKey[PANE_KEY]).toHaveLength(1)
  })
})

const workspaceState = {
  tabsByWorktree: { 'folder-workspace': [tab] },
  browserTabsByWorktree: {},
  runtimePaneTitlesByTabId: {},
  ptyIdsByTabId: {},
  terminalLayoutsByTabId: {},
  agentStatusEpoch: 0,
  agentStatusByPaneKey: {},
  migrationUnsupportedByPtyId: {},
  retainedAgentsByPaneKey: {},
  runtimeAgentOrchestrationByPaneKey: {},
  unreadTerminalTabs: {},
  unreadAgentCompletionPanes: {},
  pendingAsksByPaneKey: {}
}

const recentRow: OpenTabRecentRow['row'] = {
  id: 'tab-1',
  worktreeId: 'folder-workspace',
  unifiedTabId: 'tab-1',
  terminalTab: { id: 'tab-1', title: 'bash' },
  worktreeLastActivityAt: 0
}

describe('pending ask Cmd+J surfaces', () => {
  it('promotes the palette worktree dot while an ask is registered', () => {
    useAppStore.setState(workspaceState)
    render(
      <TooltipProvider>
        <PaletteLiveStatusProvider active>
          <PaletteWorktreeStatusDot worktree={{ id: 'folder-workspace' }} />
        </PaletteLiveStatusProvider>
      </TooltipProvider>
    )
    expect(screen.getByText(getWorktreeStatusLabel('inactive'))).toBeTruthy()

    act(() => {
      useAppStore.setState({ pendingAsksByPaneKey: { [PANE_KEY]: [card('registered')] } })
    })
    expect(screen.getByText(getWorktreeStatusLabel('permission'))).toBeTruthy()

    act(() => {
      useAppStore.setState({ pendingAsksByPaneKey: { [PANE_KEY]: [card('answered')] } })
    })
    expect(screen.getByText(getWorktreeStatusLabel('inactive'))).toBeTruthy()
  })

  it('promotes the palette recent-tab badge while an ask is registered', () => {
    useAppStore.setState(workspaceState)
    render(
      <TooltipProvider>
        <PaletteLiveStatusProvider active>
          <PaletteRecentTabStatusDot row={recentRow} fallback={<span>icon</span>} />
        </PaletteLiveStatusProvider>
      </TooltipProvider>
    )
    expect(screen.queryByText(getWorktreeStatusLabel('permission'))).toBeNull()

    act(() => {
      useAppStore.setState({ pendingAsksByPaneKey: { [PANE_KEY]: [card('registered')] } })
    })
    expect(screen.getAllByText(getWorktreeStatusLabel('permission')).length).toBeGreaterThan(0)

    act(() => {
      useAppStore.setState({ pendingAsksByPaneKey: { [PANE_KEY]: [card('answered')] } })
    })
    expect(screen.queryByText(getWorktreeStatusLabel('permission'))).toBeNull()
  })

  it('keeps the current tab in the recent section while its ask is pending', () => {
    const currentTabItem = { type: 'workspace-tab', result: { isCurrentTab: true } }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the predicate branches only on item.type and item.result.isCurrentTab; a real WorkspaceTabPaletteSearchResult carries a whole Tab, Worktree and PaletteDocument it never reads.
    const item = currentTabItem as unknown as OpenTabPaletteItem
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the predicate reads only worktree.isArchived.
    const worktree = { isArchived: false } as unknown as Worktree
    const include = (hasPendingAsk: boolean): boolean =>
      shouldIncludeOpenTabInRecentSection({
        item,
        worktree,
        row: recentRow,
        paneSources: {
          entriesByTabId: new Map(),
          ptyIdsByTabId: {},
          runtimePaneTitlesByTabId: {},
          terminalLayoutsByTabId: {}
        },
        unreadTerminalTabs: {},
        unreadAgentCompletionPanes: {},
        now: 0,
        hasPendingAsk
      })

    expect(include(false)).toBe(false)
    expect(include(true)).toBe(true)
  })

  it('exposes the asking tab id to the recent-section subscription', () => {
    useAppStore.setState(workspaceState)
    const { result } = renderHook(() => usePendingAskTabIds())
    expect(result.current.has('tab-1')).toBe(false)

    act(() => {
      useAppStore.setState({ pendingAsksByPaneKey: { [PANE_KEY]: [card('registered')] } })
    })
    expect(result.current.has('tab-1')).toBe(true)

    act(() => {
      useAppStore.setState({ pendingAsksByPaneKey: { [PANE_KEY]: [card('answered')] } })
    })
    expect(result.current.has('tab-1')).toBe(false)
  })
})
