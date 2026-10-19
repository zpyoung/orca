import type { AppState } from '@/store/types'
import { resolveOwner } from '@/lib/resolve-owner'
import type { WorktreeOperationRouteState } from '@/lib/worktree-operation-route'
import {
  parseExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../../../shared/execution-host'
import { isRemoteWindowsConptyStatusUnverified } from '@/lib/pane-manager/windows-pty-compatibility'
import { REMOTE_CONPTY_UNVERIFIED_DATASET_KEY } from './TerminalPaneDockMount'

/**
 * Whether a non-local pane's remote host makes ConPTY reliability unverifiable —
 * null for a local host (the xterm windowsPty option already covers it). Remote
 * hosts never report a ConPTY build number, so a Windows or unconfirmed remote
 * platform demotes; only a positively known non-Windows platform stays eligible.
 */
export function resolveRemoteDockConptyUnverified(args: {
  executionHostId: string
  state: Pick<AppState, 'sshConnectionStates' | 'runtimeStatusByEnvironmentId'>
}): boolean | null {
  const parsedHost = parseExecutionHostId(args.executionHostId)
  if (!parsedHost || parsedHost.kind === 'local') {
    return null
  }
  const remotePlatform =
    parsedHost.kind === 'ssh'
      ? args.state.sshConnectionStates.get(parsedHost.targetId)?.remotePlatform
      : args.state.runtimeStatusByEnvironmentId.get(parsedHost.environmentId)?.status?.hostPlatform
  return isRemoteWindowsConptyStatusUnverified(remotePlatform)
}

/**
 * `resolveRemoteDockConptyUnverified` for the host that owns the worktree's rows. A worktree no
 * row places, or that two hosts publish, reports no verdict rather than borrowing the focused
 * server's.
 */
export function resolveRemoteDockConptyUnverifiedForWorktree(
  state: WorktreeOperationRouteState &
    Pick<AppState, 'sshConnectionStates' | 'runtimeStatusByEnvironmentId'>,
  worktreeId: string | null | undefined
): boolean | null {
  if (!worktreeId) {
    return null
  }
  const match = resolveOwner(state, { workspaceId: worktreeId })
  if (match.kind !== 'resolved') {
    return null
  }
  const { endpoint, at } = match.owner
  return resolveRemoteDockConptyUnverified({
    executionHostId:
      endpoint.kind === 'environment' ? toRuntimeExecutionHostId(endpoint.environmentId) : at,
    state
  })
}

type RemoteConptyDockPaneManager = {
  getPanes(): { container: Pick<HTMLElement, 'dataset'> }[]
}

/** Re-stamps every live pane's remote-ConPTY-unverified dataset marker after SSH/runtime
 *  platform hydration — the onPaneCreated stamp only reflects what was known when a pane
 *  mounted, so a pane created before hydration must still pick up a later-confirmed verdict.
 *  Returns whether any pane's stamp actually changed, so a caller only re-renders when needed. */
export function restampRemoteDockConptyUnverifiedForLivePanes(
  manager: RemoteConptyDockPaneManager,
  remoteConptyUnverified: boolean | null
): boolean {
  if (remoteConptyUnverified === null) {
    return false
  }
  const next = String(remoteConptyUnverified)
  let changed = false
  for (const pane of manager.getPanes()) {
    if (pane.container.dataset[REMOTE_CONPTY_UNVERIFIED_DATASET_KEY] !== next) {
      pane.container.dataset[REMOTE_CONPTY_UNVERIFIED_DATASET_KEY] = next
      changed = true
    }
  }
  return changed
}
