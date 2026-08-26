import type { RepoKind } from '../repo-types'

/**
 * Whether a worktree row can own a `projectGroupId` of its own.
 *
 * Folder workspaces redirect meta writes to an allowlist that excludes
 * projectGroupId, and a folder-mode repo's synthetic worktrees project through
 * mergeFolderWorkspace, which drops it — either way the write appears to succeed and
 * vanishes on the next refresh. Every affordance that can start a membership write
 * gates on this, so it lives in one place rather than being re-derived per call site.
 *
 * Both fields are required: omitting either half would default the gate open, which
 * is the one direction that lets a silently-reverting write through.
 */
export function canWorktreeHoldGroupMembership(args: {
  folderWorkspaceId: string | null
  repoKind: RepoKind | undefined
}): boolean {
  return args.folderWorkspaceId === null && args.repoKind !== 'folder'
}
