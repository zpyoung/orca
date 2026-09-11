import type { FolderWorkspace } from '../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../shared/project-group-types'
import { folderWorkspaceKey } from '../../../../../shared/workspace-scope'
import { getFolderWorkspaceExecutionHostIdForRows } from '../worktree-list/listing/host-filtering'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import { getWorktreeVisitTimestamp } from '@/lib/worktree-visit-recency'
import type { WorkspaceActivityFilterContext } from './workspace-activity-filter'
import {
  isSelectedActivityWorkspace,
  workspaceActivityWindowDays
} from './workspace-activity-filter'
import { getRenderableFolderWorkspaces } from '../worktree-list/grouping/folder-workspace-lanes'

function activityTime(
  folder: FolderWorkspace,
  hostId: ExecutionHostId,
  context: WorkspaceActivityFilterContext
): number {
  const owner = { id: folderWorkspaceKey(folder.id), hostId }
  const visited = getWorktreeVisitTimestamp(context.lastVisitedAtByWorktreeId, owner) ?? 0
  const exited = getWorktreeVisitTimestamp(context.workspaceActivityExitStamps, owner) ?? 0
  return Math.max(folder.lastActivityAt || 0, visited, exited) || folder.createdAt
}

/** Applies the activity window after host/device filtering while retaining project membership. */
export function filterFolderWorkspacesByActivity(
  folderWorkspaces: readonly FolderWorkspace[],
  projectGroups: readonly ProjectGroup[],
  defaultHostId: ExecutionHostId,
  context: WorkspaceActivityFilterContext | undefined
): readonly FolderWorkspace[] {
  if (
    !context ||
    context.workspaceActivityWindow === 'all' ||
    context.workspaceActivityWindow === 'live-only'
  ) {
    return folderWorkspaces
  }
  const days = workspaceActivityWindowDays(
    context.workspaceActivityWindow,
    context.workspaceActivityCustomDays
  )
  if (days === null) {
    return folderWorkspaces
  }
  const cutoff = context.now - days * 86400000
  const projectGroupById = new Map(projectGroups.map((group) => [group.id, group]))
  return folderWorkspaces.filter((folder) => {
    const hostId = getFolderWorkspaceExecutionHostIdForRows({
      folderWorkspace: folder,
      projectGroup: projectGroupById.get(folder.projectGroupId),
      defaultHostId
    })
    if (isSelectedActivityWorkspace({ id: folderWorkspaceKey(folder.id), hostId }, context)) {
      return true
    }
    return activityTime(folder, hostId, context) >= cutoff
  })
}

export function filterFolderWorkspacesForActivityScope({
  folderWorkspaces,
  projectGroups,
  defaultHostId,
  context
}: {
  folderWorkspaces: readonly FolderWorkspace[]
  projectGroups: readonly ProjectGroup[]
  defaultHostId: ExecutionHostId
  context: WorkspaceActivityFilterContext | undefined
}): {
  visibleFolderWorkspaces: readonly FolderWorkspace[]
  activityHiddenFolderCount: number
} {
  const visibleFolderWorkspaces = filterFolderWorkspacesByActivity(
    folderWorkspaces,
    projectGroups,
    defaultHostId,
    context
  )
  const countableBefore = folderWorkspaces.filter((folderWorkspace) => !folderWorkspace.isArchived)
  const countableAfter = visibleFolderWorkspaces.filter(
    (folderWorkspace) => !folderWorkspace.isArchived
  )
  const beforeRenderable = getRenderableFolderWorkspaces(countableBefore, projectGroups)
  const afterIds = new Set(
    getRenderableFolderWorkspaces(countableAfter, projectGroups).map(
      ({ folderWorkspace }) => folderWorkspace.id
    )
  )
  return {
    visibleFolderWorkspaces,
    activityHiddenFolderCount: beforeRenderable.filter(
      ({ folderWorkspace }) => !afterIds.has(folderWorkspace.id)
    ).length
  }
}
