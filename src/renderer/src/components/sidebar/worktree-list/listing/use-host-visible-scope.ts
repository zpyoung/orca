import { useMemo } from 'react'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { SidebarWorktreeFilters } from './use-filters'
import { useWorkspaceActivityFilter } from '../../fork-workspace-activity-window/use-workspace-activity-filter'
import { filterFolderWorkspacesForActivityScope } from '../../fork-workspace-activity-window/workspace-activity-folder-filter'
import { filterFolderWorkspacesFromOtherDevices } from '../../workspace-creator-visibility'
import {
  filterFolderWorkspacesForVisibleHosts,
  filterProjectGroupsForVisibleHosts,
  getVisibleSidebarHostIdSet
} from './host-filtering'

// Narrows repos, project groups, and folder workspaces to the hosts (and devices) the
// current host filter admits.
export function useSidebarHostVisibleScope(args: {
  filterState: SidebarWorktreeFilters['filterState']
  defaultHostId: ExecutionHostId
  repos: readonly Repo[]
  projectGroups: readonly ProjectGroup[]
  folderWorkspaces: readonly FolderWorkspace[]
  pairedDeviceIdsByEnvironment: Parameters<typeof filterFolderWorkspacesFromOtherDevices>[1]
}) {
  const { filterState, defaultHostId, repos, projectGroups, folderWorkspaces } = args
  const { visibleWorkspaceHostIds, workspaceHostScope, hideWorkspacesFromOtherDevices } =
    filterState
  const activityContext = useWorkspaceActivityFilter()
  const visibleHostIdSet = useMemo(
    () => getVisibleSidebarHostIdSet(visibleWorkspaceHostIds, workspaceHostScope),
    [visibleWorkspaceHostIds, workspaceHostScope]
  )
  const visibleReposForRows = useMemo(() => {
    if (!visibleHostIdSet) {
      return repos
    }
    return repos.filter((repo) => {
      const hostId =
        repo.connectionId || repo.executionHostId ? getRepoExecutionHostId(repo) : defaultHostId
      return visibleHostIdSet.has(hostId)
    })
  }, [defaultHostId, repos, visibleHostIdSet])
  const visibleProjectGroupsForRows = useMemo(
    () => filterProjectGroupsForVisibleHosts(projectGroups, visibleHostIdSet, defaultHostId),
    [defaultHostId, projectGroups, visibleHostIdSet]
  )
  const { visibleFolderWorkspaces: visibleFolderWorkspacesForRows, activityHiddenFolderCount } =
    useMemo(() => {
      const hostVisibleWorkspaces = filterFolderWorkspacesForVisibleHosts(
        folderWorkspaces,
        projectGroups,
        visibleHostIdSet,
        defaultHostId
      )
      const deviceVisibleWorkspaces = hideWorkspacesFromOtherDevices
        ? filterFolderWorkspacesFromOtherDevices(
            hostVisibleWorkspaces,
            args.pairedDeviceIdsByEnvironment
          )
        : hostVisibleWorkspaces
      return filterFolderWorkspacesForActivityScope({
        folderWorkspaces: deviceVisibleWorkspaces,
        projectGroups,
        defaultHostId,
        context: activityContext
      })
    }, [
      activityContext,
      args.pairedDeviceIdsByEnvironment,
      defaultHostId,
      folderWorkspaces,
      hideWorkspacesFromOtherDevices,
      projectGroups,
      visibleHostIdSet
    ])

  return {
    visibleReposForRows,
    visibleProjectGroupsForRows,
    visibleFolderWorkspacesForRows,
    activityHiddenFolderCount
  }
}
