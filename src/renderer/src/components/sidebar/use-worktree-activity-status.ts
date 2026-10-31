import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { hasAwakeStructuredChat } from '@/store/slices/structured-chat-slept-at'
import { resolveWorktreeStatus, type WorktreeStatus } from '@/lib/worktree-status'
import { EMPTY_BROWSER_TABS, EMPTY_TABS } from './WorktreeCardHelpers'
import {
  selectLivePtyIdsForWorktree,
  selectTerminalLayoutRootsForWorktree,
  selectRuntimePaneTitlesForWorktree
} from './worktree-card-status-inputs'
import { selectWorktreeAgentActivitySummary } from './worktree-agent-activity-summary'
import { selectWorktreeHasPendingAsk } from '../fork-ask-question-tool/pending-ask-attention'

export function useWorktreeActivityStatus(worktreeId: string): WorktreeStatus {
  const hasPendingAsk = useAppStore((s) => selectWorktreeHasPendingAsk(s, worktreeId))
  const tabs = useAppStore((s) => s.tabsByWorktree[worktreeId] ?? EMPTY_TABS)
  const browserTabs = useAppStore((s) => s.browserTabsByWorktree[worktreeId] ?? EMPTY_BROWSER_TABS)
  const hasStructuredChat = useAppStore((s) =>
    hasAwakeStructuredChat(s.unifiedTabsByWorktree[worktreeId], s.structuredChatSleptAtByPaneKey)
  )
  const runtimePaneTitlesForWorktree = useAppStore(
    useShallow((s) => selectRuntimePaneTitlesForWorktree(s, worktreeId))
  )
  // Why one selector: a second subscription per card costs a store listener on every workspace.
  const ptyIdsForWorktree = useAppStore(
    useShallow((s) => {
      const ptyIds = selectLivePtyIdsForWorktree(s, worktreeId)
      if (!hasStoppedWslHost(s)) {
        return ptyIds
      }
      // A stopped distro ended its terminals, whatever bindings the panes keep for its Start.
      const owner = selectWorkspaceRuntimeEnvironmentId(s, worktreeId)
      return owner && selectStoppedWslDistro(s, owner) !== null
        ? withoutStoppedHostPtys(ptyIds, owner)
        : ptyIds
    })
  )
  const terminalLayoutRootsByTabId = useAppStore(
    useShallow((s) => selectTerminalLayoutRootsForWorktree(s, worktreeId))
  )
  const {
    hasPermission,
    hasLiveWorking,
    hasLiveMonitoring,
    hasFailed,
    hasInterrupted,
    hasUnconfirmed,
    hasLiveDone,
    hasRetainedDone,
    hasRetainedFailed,
    agentStatusPaneIdsByTabId,
    stalePaneIdsByTabId
  } = useAppStore(useShallow((s) => selectWorktreeAgentActivitySummary(s, worktreeId)))

  // Use common liveness and agent-row precedence so compact and detailed cards show the same status.
  return useMemo(
    () =>
      resolveWorktreeStatus({
        tabs,
        browserTabs,
        hasStructuredChat,
        ptyIdsByTabId: ptyIdsForWorktree,
        runtimePaneTitlesByTabId: runtimePaneTitlesForWorktree,
        agentStatusPaneIdsByTabId,
        stalePaneIdsByTabId,
        terminalLayoutRootsByTabId,
        hasPermission: hasPermission || hasPendingAsk,
        hasLiveWorking,
        hasLiveMonitoring,
        hasFailed,
        hasInterrupted,
        hasUnconfirmed,
        hasLiveDone,
        hasRetainedDone,
        hasRetainedFailed
      }),
    [
      tabs,
      browserTabs,
      hasStructuredChat,
      ptyIdsForWorktree,
      runtimePaneTitlesForWorktree,
      agentStatusPaneIdsByTabId,
      stalePaneIdsByTabId,
      terminalLayoutRootsByTabId,
      hasPermission,
      hasPendingAsk,
      hasLiveWorking,
      hasLiveMonitoring,
      hasFailed,
      hasInterrupted,
      hasUnconfirmed,
      hasLiveDone,
      hasRetainedDone,
      hasRetainedFailed
    ]
  )
}
