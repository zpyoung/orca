import { HEIMDALL_CHANNELS, type HeimdallFleetSnapshot } from '../../shared/fork-heimdall/api'
import type { WatcherFleetEntry } from '../../shared/fork-heimdall/fleet-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { RuntimeWorktreeRecord } from '../../shared/runtime-types'
import { getOptionalWorktreeSelector, normalizeWorktreeSelectorForCaller } from '../selectors'
import type { HandlerContext } from '../dispatch'
import { getRequiredStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime/types'

export async function resolveWatcherRow(
  client: HandlerContext['client'],
  watcherId: string
): Promise<WatcherFleetEntry> {
  const fleet = await client.call<HeimdallFleetSnapshot>(HEIMDALL_CHANNELS.fleet, {})
  let row: WatcherFleetEntry | undefined
  for (const entry of fleet.result.entries) {
    if (entry.target.watcherId !== watcherId) {
      continue
    }
    if (row !== undefined) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Heimdall watcher ${watcherId} is ambiguous across multiple owners`
      )
    }
    row = entry
  }
  if (row === undefined) {
    throw new RuntimeClientError('invalid_argument', `Heimdall watcher ${watcherId} was not found`)
  }
  return row
}

export async function resolveWatcherWorktreeFilter(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: HandlerContext['client']
): Promise<RuntimeWorktreeRecord | undefined> {
  const requested = flags.has('worktree') ? getRequiredStringFlag(flags, 'worktree') : undefined
  if (requested === undefined) {
    return undefined
  }
  let selector: string | undefined
  const folderWorkspaceId = process.env.ORCA_WORKSPACE_ID?.trim()
  if (
    (requested === 'active' || requested === 'current') &&
    !client.isRemote &&
    folderWorkspaceId?.startsWith('folder:')
  ) {
    selector = folderWorkspaceId
  } else if (requested === 'active' || requested === 'current') {
    selector = await getOptionalWorktreeSelector(flags, 'worktree', cwd, client)
  } else {
    selector = await normalizeWorktreeSelectorForCaller(requested, cwd, client)
  }
  if (selector === undefined) {
    throw new RuntimeClientError(
      'invalid_argument',
      'The --worktree selector did not resolve to a workspace'
    )
  }
  const response = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
    worktree: selector
  })
  return response.result.worktree
}

export function watcherMatchesWorktree(
  row: WatcherFleetEntry,
  worktree: RuntimeWorktreeRecord
): boolean {
  const enrollment = row.entry.enrollment
  const sameWorkspace =
    enrollment.worktreeId === worktree.id ||
    (enrollment.worktreeId === null &&
      enrollment.repoId === worktree.repoId &&
      enrollment.workspacePath === worktree.path)
  if (!sameWorkspace) {
    return false
  }
  if (row.target.connectionId !== null) {
    return worktree.runtimeOwnerEnvironmentId === row.target.connectionId
  }
  return (
    worktree.runtimeOwnerEnvironmentId === undefined &&
    enrollment.executionHostId === (worktree.hostId ?? LOCAL_EXECUTION_HOST_ID)
  )
}
