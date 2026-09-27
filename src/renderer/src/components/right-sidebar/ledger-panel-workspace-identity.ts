import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'

export type LedgerPanelWorkspaceSource = {
  folderWorkspaces?: readonly FolderWorkspace[]
  repos?: readonly Repo[]
  getKnownWorktreeById?: (worktreeId: string) => Worktree | undefined
}

export type LedgerPanelWorkspaceIdentity = {
  /** The workspace's own name; `null` keeps the panel from printing a raw id. */
  name: string | null
  /** Whether a group ledger exists to switch to. Unresolved workspaces report false. */
  hasGroup: boolean
}

export function getLedgerPanelWorkspaceIdentity(
  workspaceId: string | null,
  source: LedgerPanelWorkspaceSource
): LedgerPanelWorkspaceIdentity {
  if (!workspaceId) {
    return { name: null, hasGroup: false }
  }
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type === 'folder') {
    const folder = source.folderWorkspaces?.find(
      (workspace) => workspace.id === scope.folderWorkspaceId
    )
    return { name: folder?.name ?? null, hasGroup: Boolean(folder?.projectGroupId) }
  }
  const worktree = source.getKnownWorktreeById?.(workspaceId)
  const repo = worktree ? source.repos?.find((item) => item.id === worktree.repoId) : undefined
  return {
    name: worktree?.displayName ?? null,
    hasGroup: Boolean(worktree?.projectGroupId ?? repo?.projectGroupId)
  }
}
