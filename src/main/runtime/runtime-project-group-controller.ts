import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import type {
  FolderWorkspacePathStatus,
  FolderWorkspacePathStatusRequest
} from '../../shared/folder-workspace-path-status'
import {
  assertFolderWorkspacePathUsable,
  getFolderWorkspacePathStatus,
  getFolderWorkspacePathStatusForPath
} from '../project-groups/folder-workspace-path-status'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import type { RuntimeStore } from './runtime-store-contract'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { invalidateAuthorizedRootsCache } from '../ipc/filesystem-auth'
import {
  markDetachedLedgers,
  type DetachedLedgerRemoval,
  type ExpectedLedgerRevision,
  type LedgerCatalogRemoval
} from './runtime-ledger-catalog-removal'

type RuntimeProjectGroupDependencies = {
  getStore: () => RuntimeStore | null
  resolveRepo: (selector: string) => Promise<Repo>
  notifyReposChanged: () => void
  forgetTerminalTopology?: (repoId: string) => void
  invalidateResolvedWorktrees?: () => void
  invalidateWorktreeScan?: (repoId: string) => void
  withCatalogRemoval?: LedgerCatalogRemoval
  resolveFolderConnectionId: (workspace: FolderWorkspace) => string | null
  teardownFolderWorkspacePtys: (worktreeId: string, connectionId: string | null) => Promise<void>
  cleanupRemovedFolderWorkspaceState: (worktreeId: string) => void
}

type FolderWorkspaceUpdates = Partial<
  Pick<
    FolderWorkspace,
    | 'name'
    | 'folderPath'
    | 'linkedTask'
    | 'linkedTaskSourceContext'
    | 'comment'
    | 'isArchived'
    | 'isUnread'
    | 'isPinned'
    | 'sortOrder'
    | 'manualOrder'
    | 'workspaceStatus'
    | 'createdWithAgent'
    | 'pendingFirstAgentMessageRename'
    | 'firstAgentMessageRenameError'
    | 'lastActivityAt'
    | 'diffComments'
  >
>

export class RuntimeProjectGroupController {
  constructor(private readonly deps: RuntimeProjectGroupDependencies) {}

  listGroups(): ProjectGroup[] {
    return this.deps.getStore()?.getProjectGroups?.() ?? []
  }

  listFolderWorkspaces(): FolderWorkspace[] {
    return this.deps.getStore()?.getFolderWorkspaces?.() ?? []
  }

  async createGroup(input: {
    name: string
    parentPath?: string | null
    connectionId?: string | null
    parentGroupId?: string | null
    createdFrom?: ProjectGroup['createdFrom']
  }): Promise<ProjectGroup> {
    const store = this.deps.getStore()
    if (!store?.createProjectGroup) {
      throw new Error('runtime_unavailable')
    }
    const group = store.createProjectGroup({
      name: input.name,
      parentPath: input.parentPath ?? null,
      connectionId: input.connectionId ?? null,
      parentGroupId: input.parentGroupId ?? null,
      createdFrom: input.createdFrom ?? 'manual'
    })
    this.deps.notifyReposChanged()
    return group
  }

  async updateGroup(
    groupId: string,
    updates: Partial<Pick<ProjectGroup, 'name' | 'isCollapsed' | 'tabOrder' | 'color'>>
  ): Promise<ProjectGroup | null> {
    const store = this.deps.getStore()
    if (!store?.updateProjectGroup) {
      throw new Error('runtime_unavailable')
    }
    const updated = store.updateProjectGroup(groupId, updates)
    if (updated) {
      this.deps.notifyReposChanged()
    }
    return updated
  }

  async deleteGroup(
    groupId: string,
    options?: { expectedLedgers?: ExpectedLedgerRevision[]; removeContainedProjects?: boolean }
  ): Promise<{ deleted: boolean; ledgers?: DetachedLedgerRemoval[] }> {
    const store = this.deps.getStore()
    if (!store?.deleteProjectGroup) {
      throw new Error('runtime_unavailable')
    }
    const groupIds = new Set<string>([groupId])
    const pendingGroups = [groupId]
    while (pendingGroups.length) {
      const parent = pendingGroups.pop()!
      for (const child of this.listGroups()) {
        if (child.parentGroupId === parent && !groupIds.has(child.id)) {
          groupIds.add(child.id)
          pendingGroups.push(child.id)
        }
      }
    }
    const reposBefore = store
      .getRepos()
      .filter((repo) => repo.projectGroupId && groupIds.has(repo.projectGroupId))
      .map((repo) => ({ id: repo.id, hostId: getRepoExecutionHostId(repo) }))
    const operation = (): boolean => {
      if (options?.removeContainedProjects) {
        for (const repo of reposBefore) {
          const remaining = store
            .getRepos()
            .some(
              (candidate) =>
                candidate.id === repo.id && getRepoExecutionHostId(candidate) !== repo.hostId
            )
          if (remaining) {
            store.removeProjectForHost?.(repo.id, repo.hostId)
          } else {
            store.removeProject?.(repo.id)
          }
        }
      }
      return store.deleteProjectGroup!(groupId)
    }
    const removed = this.deps.withCatalogRemoval
      ? await this.deps.withCatalogRemoval(
          { projectGroupId: groupId, removeContainedProjects: options?.removeContainedProjects },
          options?.expectedLedgers,
          operation
        )
      : { result: operation(), ledgers: [] }
    const deleted = removed.result
    if (deleted) {
      if (options?.removeContainedProjects) {
        // Why: contained projects are dropped straight from the store here, so they never pass
        // through removeProject's invalidations and would leave authorized roots and worktree
        // caches pointing at forgotten checkouts.
        for (const repo of reposBefore) {
          this.deps.forgetTerminalTopology?.(repo.id)
          this.deps.invalidateWorktreeScan?.(repo.id)
        }
        this.deps.invalidateResolvedWorktrees?.()
        invalidateAuthorizedRootsCache()
      }
      this.deps.notifyReposChanged()
    }
    return {
      deleted,
      ...(deleted && removed.ledgers.length
        ? { ledgers: markDetachedLedgers(removed.ledgers) }
        : {})
    }
  }

  async moveProject(repoSelector: string, groupId: string | null, order?: number): Promise<Repo> {
    const store = this.deps.getStore()
    if (!store?.moveProjectToGroup) {
      throw new Error('runtime_unavailable')
    }
    const repo = await this.deps.resolveRepo(repoSelector)
    const moved = store.moveProjectToGroup(repo.id, groupId, order)
    if (!moved) {
      throw new Error('repo_not_found')
    }
    this.deps.notifyReposChanged()
    return moved
  }

  async createFolderWorkspace(input: {
    projectGroupId: string
    name?: string
    folderPath?: string | null
    connectionId?: string | null
    creatorProvenance?: FolderWorkspace['creatorProvenance']
    linkedTask?: FolderWorkspace['linkedTask']
    linkedTaskSourceContext?: FolderWorkspace['linkedTaskSourceContext']
    createdWithAgent?: FolderWorkspace['createdWithAgent']
    pendingFirstAgentMessageRename?: boolean
  }): Promise<FolderWorkspace> {
    const store = this.deps.getStore()
    if (!store?.createFolderWorkspace) {
      throw new Error('runtime_unavailable')
    }
    const projectGroups = store.getProjectGroups?.() ?? []
    const group = projectGroups.find((entry) => entry.id === input.projectGroupId)
    const folderPath =
      typeof input.folderPath === 'string' && input.folderPath.trim().length > 0
        ? input.folderPath
        : group?.parentPath
    if (!group || !folderPath) {
      throw new Error('folder_workspace_project_group_not_found')
    }
    const status = await getFolderWorkspacePathStatusForPath(
      {
        folderPath,
        projectGroupId: group.id,
        connectionId: input.connectionId ?? group.connectionId ?? null,
        projectGroups,
        repos: store.getRepos()
      },
      { getSshFilesystemProvider }
    )
    assertFolderWorkspacePathUsable(status)
    const workspace = store.createFolderWorkspace({
      ...input,
      creatorProvenance: input.creatorProvenance ?? { kind: 'host' }
    })
    this.deps.notifyReposChanged()
    return workspace
  }

  async getFolderPathStatus(
    request: FolderWorkspacePathStatusRequest
  ): Promise<FolderWorkspacePathStatus> {
    const store = this.deps.getStore()
    if (!store) {
      throw new Error('runtime_unavailable')
    }
    return getFolderWorkspacePathStatus(store, request, { getSshFilesystemProvider })
  }

  async updateFolderWorkspace(
    folderWorkspaceId: string,
    updates: FolderWorkspaceUpdates
  ): Promise<FolderWorkspace | null> {
    const store = this.deps.getStore()
    if (!store?.updateFolderWorkspace) {
      throw new Error('runtime_unavailable')
    }
    if (typeof updates.folderPath === 'string' && updates.folderPath.trim().length > 0) {
      const workspace = store
        .getFolderWorkspaces?.()
        .find((entry) => entry.id === folderWorkspaceId)
      if (!workspace) {
        return null
      }
      const projectGroups = store.getProjectGroups?.() ?? []
      const status = await getFolderWorkspacePathStatusForPath(
        {
          folderPath: updates.folderPath,
          projectGroupId: workspace.projectGroupId,
          connectionId:
            workspace.connectionId ??
            projectGroups.find((entry) => entry.id === workspace.projectGroupId)?.connectionId ??
            null,
          projectGroups,
          repos: store.getRepos()
        },
        { getSshFilesystemProvider }
      )
      assertFolderWorkspacePathUsable(status)
    }
    const updated = store.updateFolderWorkspace(folderWorkspaceId, updates)
    if (updated) {
      this.deps.notifyReposChanged()
    }
    return updated
  }

  async deleteFolderWorkspace(folderWorkspaceId: string): Promise<{ deleted: boolean }> {
    const store = this.deps.getStore()
    if (!store?.removeFolderWorkspace) {
      throw new Error('runtime_unavailable')
    }
    const workspace = store.getFolderWorkspaces?.().find((entry) => entry.id === folderWorkspaceId)
    if (workspace) {
      const worktreeId = folderWorkspaceKey(folderWorkspaceId)
      // Why: a mixed-host group has no single PTY target; forgetting the
      // workspace must still succeed, so skip the sweep instead of failing.
      let connectionId: string | null | undefined
      try {
        connectionId = this.deps.resolveFolderConnectionId(workspace)
      } catch (error) {
        console.warn(`[folder-workspace] skipping PTY teardown for ${worktreeId}:`, error)
      }
      if (connectionId !== undefined) {
        await this.deps.teardownFolderWorkspacePtys(worktreeId, connectionId)
      }
      this.deps.cleanupRemovedFolderWorkspaceState(worktreeId)
    }
    const deleted = store.removeFolderWorkspace(folderWorkspaceId)
    if (deleted) {
      this.deps.notifyReposChanged()
    }
    return { deleted }
  }
}
