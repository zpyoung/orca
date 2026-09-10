import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { getAgentStatusEpochNow } from '@/lib/agent-status-epoch-clock'
import { getWorktreeIdsWithLiveAgent } from '@/lib/worktree-activity-state'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import { getSettingsFocusedExecutionHostId } from '../../../../../../shared/execution-host'
import { computeVisibleWorktrees, type VisibleWorktreeOptions } from '../../visible-worktrees'
import { computeActivityVisibility } from '../../fork-workspace-activity-window/compute-activity-visibility'
import { useWorkspaceActivityFilter } from '../../fork-workspace-activity-window/use-workspace-activity-filter'
import { useWorkspaceReviewFilter } from '../../fork-workspace-review-filters/use-workspace-review-filter'
import {
  EMPTY_PAIRED_DEVICE_IDS_BY_ENVIRONMENT,
  getPairedDeviceIdsByEnvironment
} from '../../workspace-creator-visibility'
import {
  getVisibleWorktreeBrowserActivityTabs,
  getVisibleWorktreeTerminalActivityTabs
} from '../../visible-worktree-activity-inputs'
import type { SortBy } from '../../smart-sort'
import type { SidebarWorktreeFilters } from './use-filters'
import { useReusedArrayIdentity } from './use-reused-array-identity'

const EMPTY_WORKTREE_ID_SET: ReadonlySet<string> = new Set()

// Applies every sidebar filter to the sorted id stream. Flatten/filter/sort goes through the
// shared utility so card order matches Cmd+1–9 numbering.
export function useVisibleSidebarWorktrees(args: {
  filterState: SidebarWorktreeFilters['filterState']
  sortBy: SortBy
  sortedIds: string[]
  repoMap: Map<string, Repo>
  worktreeLineageById: Record<string, WorktreeLineage>
  settings: AppState['settings']
  agentSendTargetWorktreeId: string | null
}) {
  const { filterState, sortBy, sortedIds, repoMap, worktreeLineageById, settings } = args
  const {
    showSleepingWorkspaces,
    filterRepoIds,
    hideDefaultBranchWorkspace,
    hideAutomationGeneratedWorkspaces,
    hideCliCreatedWorkspaces,
    hideDetachedHeadWorkspaces,
    hideWorkspacesFromOtherDevices,
    alwaysShowDefaultBranchWorkspace,
    visibleWorkspaceHostIds,
    workspaceHostScope
  } = filterState
  const workspaceActivity = useWorkspaceActivityFilter()
  const workspaceReview = useWorkspaceReviewFilter()
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const agentStatusEpoch = useAppStore((s) => (!showSleepingWorkspaces ? s.agentStatusEpoch : 0))
  // Why: skip the clock entirely when the epoch is the opt-out sentinel, so a
  // sleeping-workspaces list cannot evict the sample the live lists share.
  const agentStatusNow = showSleepingWorkspaces ? 0 : getAgentStatusEpochNow(agentStatusEpoch)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const runtimeStatusByEnvironmentId = useAppStore((s) => s.runtimeStatusByEnvironmentId)
  const pairedDeviceIdsByEnvironment = useMemo(
    () =>
      hideWorkspacesFromOtherDevices
        ? getPairedDeviceIdsByEnvironment(runtimeEnvironments, runtimeStatusByEnvironmentId)
        : EMPTY_PAIRED_DEVICE_IDS_BY_ENVIRONMENT,
    [hideWorkspacesFromOtherDevices, runtimeEnvironments, runtimeStatusByEnvironmentId]
  )

  // Read tabsByWorktree when needed for filtering or sorting
  const needsActivityMaps = !showSleepingWorkspaces || sortBy === 'smart'
  const tabsByWorktree = useAppStore((s) =>
    needsActivityMaps ? getVisibleWorktreeTerminalActivityTabs(s.tabsByWorktree) : null
  )
  const ptyIdsByTabId = useAppStore((s) => (needsActivityMaps ? s.ptyIdsByTabId : null))
  const browserTabsByWorktree = useAppStore((s) =>
    !showSleepingWorkspaces ? getVisibleWorktreeBrowserActivityTabs(s.browserTabsByWorktree) : null
  )

  const recomputedVisibleWorktrees = useMemo(() => {
    // Keyed on the epoch, not `agentStatusNow`: two bumps in one millisecond
    // share a sample, so the timestamp alone would not re-key this memo.
    void agentStatusEpoch
    const options: VisibleWorktreeOptions = {
      filterRepoIds,
      showSleepingWorkspaces,
      tabsByWorktree,
      ptyIdsByTabId,
      browserTabsByWorktree,
      // Why snapshot on agentStatusEpoch: update membership immediately without repainting on every hook ping.
      worktreeIdsWithLiveAgent: showSleepingWorkspaces
        ? EMPTY_WORKTREE_ID_SET
        : getWorktreeIdsWithLiveAgent(
            useAppStore.getState().agentStatusByPaneKey,
            tabsByWorktree,
            agentStatusNow
          ),
      hideDefaultBranchWorkspace,
      hideAutomationGeneratedWorkspaces,
      hideCliCreatedWorkspaces,
      hideDetachedHeadWorkspaces,
      hideWorkspacesFromOtherDevices,
      pairedDeviceIdsByEnvironment,
      alwaysShowDefaultBranchWorkspace,
      repoMap,
      workspaceHostScope,
      visibleWorkspaceHostIds,
      defaultHostId: getSettingsFocusedExecutionHostId(settings),
      workspaceActivity,
      workspaceReview,
      worktreeLineageById,
      forcedVisibleWorktreeIds: args.agentSendTargetWorktreeId
        ? [args.agentSendTargetWorktreeId]
        : undefined
    }
    return computeActivityVisibility(options, (nextOptions) =>
      computeVisibleWorktrees(worktreesByRepo, sortedIds, nextOptions)
    )
  }, [
    args.agentSendTargetWorktreeId,
    agentStatusEpoch,
    agentStatusNow,
    filterRepoIds,
    showSleepingWorkspaces,
    hideDefaultBranchWorkspace,
    hideAutomationGeneratedWorkspaces,
    hideCliCreatedWorkspaces,
    hideDetachedHeadWorkspaces,
    hideWorkspacesFromOtherDevices,
    alwaysShowDefaultBranchWorkspace,
    workspaceHostScope,
    visibleWorkspaceHostIds,
    settings,
    repoMap,
    tabsByWorktree,
    ptyIdsByTabId,
    browserTabsByWorktree,
    workspaceActivity,
    workspaceReview,
    sortedIds,
    worktreeLineageById,
    worktreesByRepo,
    pairedDeviceIdsByEnvironment
  ])
  // Why: agentStatusEpoch bumps recompute this memo even when membership and
  // order are unchanged; keeping the previous identity stops the whole
  // rows/sectionRows/renderedWorktrees chain from churning per epoch.
  const visibleWorktrees = useReusedArrayIdentity(recomputedVisibleWorktrees.worktrees)

  return {
    visibleWorktrees,
    activityHiddenCount: recomputedVisibleWorktrees.activityHiddenCount,
    pairedDeviceIdsByEnvironment
  }
}
