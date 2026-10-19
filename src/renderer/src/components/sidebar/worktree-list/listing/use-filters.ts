import { useCallback } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store'
import { DEFAULT_SHOW_SLEEPING_WORKSPACES } from '../../../../../../shared/constants'
import {
  clearSidebarFilters,
  selectSidebarFilterState,
  sidebarHasActiveFilters,
  sidebarWorkspaceRowFilters
} from '../../sidebar-filter-actions'
import { useShallow } from 'zustand/react/shallow'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  activeWorkspaceRowFilterKeys,
  isSleepingSweepExempt,
  type WorkspaceRowFilters
} from '../../../../../../shared/workspace-view/workspace-row-filters'
import { resolveVisibleWorkspaceHostIds } from '../../../../../../shared/workspace-view/workspace-host-visibility'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import {
  getWorktreeExecutionHostId,
  getSettingsFocusedExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import {
  isAutomationGeneratedWorkspace,
  isCliCreatedWorkspace,
  isDefaultBranchWorkspace,
  isDetachedHeadWorkspace
} from '../../../../../../shared/worktree/workspace-kinds'
import { getFolderWorkspaceExecutionHostIdForRows } from '../../../../../../shared/sidebar-list/host-filtering'
import {
  getPairedDeviceIdsByEnvironment,
  isWorkspaceOwnedBySomeoneElse
} from '../../../../../../shared/workspace-creator-visibility'
import { getAgentStatusEpochNow } from '@/lib/agent-status-epoch-clock'
import { getWorktreeIdsWithLiveAgent, isInactiveWorkspace } from '@/lib/worktree-activity-state'
import {
  getVisibleWorktreeBrowserActivityTabs,
  getVisibleWorktreeTerminalActivityTabs,
  getWorktreeIdsWithStructuredChat
} from '../../visible-worktree-activity-inputs'
import { useWorkspaceFilterChrome } from '../../fork-workspace-activity-window/use-workspace-filter-chrome'
import type { SidebarFilterState } from '../../visible-worktree-kinds'

export type SidebarWorktreeFilters = ReturnType<typeof useSidebarWorktreeFilters>

type RevealContext = {
  state: AppState
  worktree: Worktree
  repo: Repo | undefined
  targetHostId: ExecutionHostId
}

/**
 * For each active filter, how to make one workspace visible again. Keyed on the shared filter
 * keys, so a new filter fails to compile until it says how a hidden workspace is revealed.
 */
const REVEAL_WORKSPACE: Record<keyof WorkspaceRowFilters, (context: RevealContext) => void> = {
  filterRepoIds: ({ state, worktree }) => {
    if (!worktree.id.startsWith('folder:') && !state.filterRepoIds.includes(worktree.repoId)) {
      state.setFilterRepoIds([...state.filterRepoIds, worktree.repoId])
    }
  },
  visibleHostIds: ({ state, targetHostId }) => {
    const shown = resolveVisibleWorkspaceHostIds(
      state.visibleWorkspaceHostIds,
      state.workspaceHostScope
    )
    if (shown && !shown.includes(targetHostId)) {
      state.setVisibleWorkspaceHostIds([...shown, targetHostId])
    }
  },
  hideDefaultBranchWorkspace: ({ state, worktree, repo }) => {
    if (isDefaultBranchWorkspace(worktree, repo)) {
      state.setHideDefaultBranchWorkspace(false)
    }
  },
  hideAutomationGeneratedWorkspaces: ({ state, worktree }) => {
    if (isAutomationGeneratedWorkspace(worktree)) {
      state.setHideAutomationGeneratedWorkspaces(false)
    }
  },
  hideCliCreatedWorkspaces: ({ state, worktree }) => {
    if (isCliCreatedWorkspace(worktree)) {
      state.setHideCliCreatedWorkspaces(false)
    }
  },
  hideDetachedHeadWorkspaces: ({ state, worktree }) => {
    if (isDetachedHeadWorkspace(worktree)) {
      state.setHideDetachedHeadWorkspaces(false)
    }
  },
  hideWorkspacesFromOtherDevices: ({ state, worktree }) => {
    const pairedDeviceIds = getPairedDeviceIdsByEnvironment(
      state.runtimeEnvironments,
      state.runtimeStatusByEnvironmentId
    )
    if (isWorkspaceOwnedBySomeoneElse(worktree, pairedDeviceIds)) {
      state.setHideWorkspacesFromOtherDevices(false)
    }
  },
  hideSleepingWorkspaces: ({ state, worktree }) => {
    const tabsByWorktree = getVisibleWorktreeTerminalActivityTabs(state.tabsByWorktree)
    const browserTabsByWorktree = getVisibleWorktreeBrowserActivityTabs(state.browserTabsByWorktree)
    const liveAgentWorktrees = getWorktreeIdsWithLiveAgent(
      state.agentStatusByPaneKey,
      tabsByWorktree,
      getAgentStatusEpochNow(state.agentStatusEpoch)
    )
    if (
      !isSleepingSweepExempt(worktree.isMainWorktree, state.alwaysShowDefaultBranchWorkspace) &&
      isInactiveWorkspace(
        worktree.id,
        tabsByWorktree,
        state.ptyIdsByTabId,
        browserTabsByWorktree,
        liveAgentWorktrees,
        getWorktreeIdsWithStructuredChat(state.unifiedTabsByWorktree)
      )
    ) {
      state.setShowSleepingWorkspaces(true)
    }
  },
  // Turning the exemption off only narrows; "Hide sleeping" above is what reveals.
  alwaysShowDefaultBranchWorkspace: () => {}
}

function getRevealTargetHostId(state: AppState, worktree: Worktree, repo: Repo | undefined) {
  const defaultHostId = getSettingsFocusedExecutionHostId(state.settings)
  const workspaceScope = parseWorkspaceKey(worktree.id)
  if (workspaceScope?.type === 'folder') {
    const folderWorkspace = state.folderWorkspaces.find(
      (candidate) => candidate.id === workspaceScope.folderWorkspaceId
    )
    if (folderWorkspace) {
      return getFolderWorkspaceExecutionHostIdForRows({
        folderWorkspace,
        projectGroup: state.projectGroups.find(
          (candidate) => candidate.id === folderWorkspace.projectGroupId
        ),
        defaultHostId
      })
    }
  }
  return getWorktreeExecutionHostId(worktree, repo, defaultHostId)
}

// Every sidebar filter, plus the single escape hatch that resets all of them.
export function useSidebarWorktreeFilters() {
  const { state: forkState, clearFilters: clearForkFilters } = useWorkspaceFilterChrome()
  const showSleepingWorkspaces = useAppStore((s) => s.showSleepingWorkspaces)
  const filterRepoIds = useAppStore((s) => s.filterRepoIds)
  const hideDefaultBranchWorkspace = useAppStore((s) => s.hideDefaultBranchWorkspace)
  const hideAutomationGeneratedWorkspaces = useAppStore((s) => s.hideAutomationGeneratedWorkspaces)
  const hideCliCreatedWorkspaces = useAppStore((s) => s.hideCliCreatedWorkspaces)
  const hideDetachedHeadWorkspaces = useAppStore((s) => s.hideDetachedHeadWorkspaces)
  const hideWorkspacesFromOtherDevices = useAppStore((s) => s.hideWorkspacesFromOtherDevices)
  const alwaysShowDefaultBranchWorkspace = useAppStore((s) => s.alwaysShowDefaultBranchWorkspace)
  const visibleWorkspaceHostIds = useAppStore((s) => s.visibleWorkspaceHostIds)
  const workspaceHostScope = useAppStore((s) => s.workspaceHostScope)
  const setShowSleepingWorkspaces = useAppStore((s) => s.setShowSleepingWorkspaces)
  const setHideDefaultBranchWorkspace = useAppStore((s) => s.setHideDefaultBranchWorkspace)
  const setHideAutomationGeneratedWorkspaces = useAppStore(
    (s) => s.setHideAutomationGeneratedWorkspaces
  )
  const setHideCliCreatedWorkspaces = useAppStore((s) => s.setHideCliCreatedWorkspaces)
  const setHideDetachedHeadWorkspaces = useAppStore((s) => s.setHideDetachedHeadWorkspaces)
  const setHideWorkspacesFromOtherDevices = useAppStore((s) => s.setHideWorkspacesFromOtherDevices)
  const setAlwaysShowDefaultBranchWorkspace = useAppStore(
    (s) => s.setAlwaysShowDefaultBranchWorkspace
  )
  const setFilterRepoIds = useAppStore((s) => s.setFilterRepoIds)
  const setVisibleWorkspaceHostIds = useAppStore((s) => s.setVisibleWorkspaceHostIds)

  const revealWorkspaceFilters = useCallback((worktree: Worktree) => {
    const state = useAppStore.getState()
    const repo = state.repos.find((candidate) => candidate.id === worktree.repoId)
    const context = {
      state,
      worktree,
      repo,
      targetHostId: getRevealTargetHostId(state, worktree, repo)
    }
    for (const key of activeWorkspaceRowFilterKeys(sidebarWorkspaceRowFilters(state))) {
      REVEAL_WORKSPACE[key](context)
    }
  }, [])

  // Why: count hideDefaultBranchWorkspace as a filter so the Clear Filters escape hatch stays reachable when it alone empties the list.
  const filterState = useMemo<
    SidebarFilterState & Pick<AppState, 'visibleWorkspaceHostIds' | 'workspaceHostScope'>
  >(
    () => ({
      showSleepingWorkspaces,
      filterRepoIds,
      hideDefaultBranchWorkspace,
      hideAutomationGeneratedWorkspaces,
      hideCliCreatedWorkspaces,
      hideDetachedHeadWorkspaces,
      hideWorkspacesFromOtherDevices,
      alwaysShowDefaultBranchWorkspace,
      visibleWorkspaceHostIds,
      workspaceHostScope,
      ...forkState
    }),
    [
      showSleepingWorkspaces,
      filterRepoIds,
      hideDefaultBranchWorkspace,
      hideAutomationGeneratedWorkspaces,
      hideCliCreatedWorkspaces,
      hideDetachedHeadWorkspaces,
      hideWorkspacesFromOtherDevices,
      alwaysShowDefaultBranchWorkspace,
      visibleWorkspaceHostIds,
      workspaceHostScope,
      forkState
    ]
  )

  const clearFilters = useCallback(() => {
    const actions = computeClearFilterActions(filterState)
    clearForkFilters()
    if (actions.resetShowSleepingWorkspaces) {
      setShowSleepingWorkspaces(DEFAULT_SHOW_SLEEPING_WORKSPACES)
    }
    if (actions.resetFilterRepoIds) {
      setFilterRepoIds([])
    }
    if (actions.resetHideDefaultBranchWorkspace) {
      setHideDefaultBranchWorkspace(false)
    }
    if (actions.resetHideAutomationGeneratedWorkspaces) {
      setHideAutomationGeneratedWorkspaces(false)
    }
    if (actions.resetHideCliCreatedWorkspaces) {
      setHideCliCreatedWorkspaces(false)
    }
    if (actions.resetHideDetachedHeadWorkspaces) {
      setHideDetachedHeadWorkspaces(false)
    }
    if (actions.resetHideWorkspacesFromOtherDevices) {
      setHideWorkspacesFromOtherDevices(false)
    }
    if (actions.resetAlwaysShowDefaultBranchWorkspace) {
      setAlwaysShowDefaultBranchWorkspace(true)
    }
    if (actions.resetVisibleWorkspaceHostIds) {
      setVisibleWorkspaceHostIds(null)
    }
  }, [
    clearForkFilters,
    setShowSleepingWorkspaces,
    setFilterRepoIds,
    setHideDefaultBranchWorkspace,
    setHideAutomationGeneratedWorkspaces,
    setHideCliCreatedWorkspaces,
    setHideDetachedHeadWorkspaces,
    setHideWorkspacesFromOtherDevices,
    setAlwaysShowDefaultBranchWorkspace,
    setVisibleWorkspaceHostIds,
    filterState
  ])

  return {
    filterState,
    hasFilters: sidebarHasActiveFilters(filterState),
    clearFilters,
    revealWorkspaceFilters
  }
}
