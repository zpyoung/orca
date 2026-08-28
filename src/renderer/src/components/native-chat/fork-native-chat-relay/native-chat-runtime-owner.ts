// FORK-COPY-OF: src/renderer/src/components/native-chat/native-chat-runtime-owner.ts
// FORK-COPY-SHA: 54076453b2725b39e07f07acd438d47b593d0d10
import {
  getRuntimeEnvironmentIdForWorktree,
  type WorktreeRuntimeOwnerState
} from '@/lib/worktree-runtime-owner'
import {
  getConnectionIdFromState,
  type ConnectionOwnerState
} from '@/lib/connection-owner-resolution'
import { isRuntimeOwnedSshTargetId } from '../../../../../shared/execution-host'
import type { AppState } from '@/store/types'
import { findTerminalTabWorktreeId } from '../native-chat-file-link'

export type NativeChatRuntimeOwnerState = Pick<AppState, 'tabsByWorktree'> &
  WorktreeRuntimeOwnerState

/**
 * The runtime owner id for a Native Chat pane, as a primitive — non-null only for
 * `runtime:` hosts (Model B), null for local and `ssh:` (Model A stays local).
 *
 * KTD-1: intentionally decoupled from `resolveNativeChatFileLinkContext`, which
 * returns null whenever the worktree *path* can't resolve (store hydration, folder
 * scopes, a remote worktree whose path hasn't landed). In that window the owner is
 * still knowable and the transport must route to the runtime — reusing the
 * path-coupled context would fall back to local session data, the exact bug this
 * kills. Resolve the owner from the tab→worktree mapping alone; do not merge the
 * two selections. The shared helper (`findTerminalTabWorktreeId`) is the right
 * level of reuse.
 */
export function selectNativeChatRuntimeEnvironmentId(
  state: NativeChatRuntimeOwnerState,
  terminalTabId: string
): string | null {
  const worktreeId = findTerminalTabWorktreeId(state.tabsByWorktree, terminalTabId)
  return worktreeId ? getRuntimeEnvironmentIdForWorktree(state, worktreeId) : null
}

export type NativeChatSshOwnerState = NativeChatRuntimeOwnerState & ConnectionOwnerState

/**
 * The plain-`ssh:` connection that owns a Native Chat pane, or null.
 *
 * Non-null means the agent's transcript lives on a host this process cannot
 * read, so transcript IO must run on that host's relay. Runtime-owned SSH
 * targets are excluded: they are Model B and already read over runtime RPC.
 */
export function selectNativeChatSshConnectionId(
  state: NativeChatSshOwnerState,
  terminalTabId: string
): string | null {
  const worktreeId = findTerminalTabWorktreeId(state.tabsByWorktree, terminalTabId)
  if (!worktreeId || getRuntimeEnvironmentIdForWorktree(state, worktreeId)) {
    return null
  }
  const connectionId = getConnectionIdFromState(state, worktreeId)
  return connectionId && !isRuntimeOwnedSshTargetId(connectionId) ? connectionId : null
}
