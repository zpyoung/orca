import { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store'
import { DEFAULT_SHOW_SLEEPING_WORKSPACES } from '../../../../../../shared/constants'
import { computeClearFilterActions, sidebarHasActiveFilters } from '../../visible-worktrees'
import { useWorkspaceFilterChrome } from '../../fork-workspace-activity-window/use-workspace-filter-chrome'
import type { SidebarFilterState } from '../../visible-worktree-kinds'

export type SidebarWorktreeFilters = ReturnType<typeof useSidebarWorktreeFilters>

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
  return { filterState, hasFilters: sidebarHasActiveFilters(filterState), clearFilters }
}
