import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { Project } from '../../../shared/project-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { RuntimeWorktreeListResult } from '../../../shared/runtime-types'
import { callRuntimeRpc, type RuntimeClientTarget } from './runtime-rpc-client'

export type LedgerCatalog = {
  projects: Project[]
  groups: ProjectGroup[]
  folderWorkspaces: FolderWorkspace[]
  worktrees: RuntimeWorktreeListResult['worktrees']
}

/** Reads all owner/location choices from the selected runtime; incomplete worktree catalogs fail closed. */
export async function readLedgerCatalog(target: RuntimeClientTarget): Promise<LedgerCatalog> {
  const [projects, groups, folders, worktreeResult] = await Promise.all([
    callRuntimeRpc<{ projects: Project[] }>(target, 'project.list'),
    callRuntimeRpc<{ groups: ProjectGroup[] }>(target, 'projectGroup.list'),
    callRuntimeRpc<{ folderWorkspaces: FolderWorkspace[] }>(target, 'folderWorkspace.list'),
    callRuntimeRpc<RuntimeWorktreeListResult>(target, 'worktree.list', {})
  ])
  if (worktreeResult.truncated || worktreeResult.totalCount !== worktreeResult.worktrees.length) {
    throw new Error(
      'Workspace catalog is incomplete; refresh before choosing a ledger location or owner.'
    )
  }
  return {
    projects: projects.projects,
    groups: groups.groups,
    folderWorkspaces: folders.folderWorkspaces,
    worktrees: worktreeResult.worktrees
  }
}
