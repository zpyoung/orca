import type { WorkspaceKey, WorkspaceScope } from './types'

export function worktreeWorkspaceKey(worktreeId: string): WorkspaceKey {
  return `worktree:${worktreeId}`
}

export function folderWorkspaceKey(folderWorkspaceId: string): WorkspaceKey {
  return `folder:${folderWorkspaceId}`
}

export function parseWorkspaceKey(value: string): WorkspaceScope | null {
  if (value.startsWith('worktree:')) {
    const worktreeId = value.slice('worktree:'.length)
    return worktreeId.length > 0 ? { type: 'worktree', worktreeId } : null
  }
  if (value.startsWith('folder:')) {
    const folderWorkspaceId = value.slice('folder:'.length)
    return folderWorkspaceId.length > 0 ? { type: 'folder', folderWorkspaceId } : null
  }
  return null
}

export function isWorkspaceKey(value: string): value is WorkspaceKey {
  return parseWorkspaceKey(value) !== null
}

// Why: folder workspaces are tracked by the scoped active key, while older
// worktree-only paths still read activeWorktreeId.
export function getActiveSidebarWorkspaceId(
  activeWorkspaceKey: string | null,
  activeWorktreeId: string | null
): string | null {
  const scope = activeWorkspaceKey ? parseWorkspaceKey(activeWorkspaceKey) : null
  if (scope?.type === 'folder') {
    return folderWorkspaceKey(scope.folderWorkspaceId)
  }
  if (scope?.type === 'worktree') {
    return scope.worktreeId
  }
  return activeWorktreeId
}

// Why: folder workspace ids reach the ledger both bare (CLI) and `folder:`-prefixed (UI),
// so origin/filter comparison has to happen on the scoped key, not the raw string.
export function isSameWorkspaceId(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  if (!left || !right) {
    return false
  }
  if (left === right) {
    return true
  }
  if (!left.startsWith('folder:') && !right.startsWith('folder:')) {
    return false
  }
  const key = (id: string) =>
    folderWorkspaceKey(id.startsWith('folder:') ? id.slice('folder:'.length) : id)
  return key(left) === key(right)
}
