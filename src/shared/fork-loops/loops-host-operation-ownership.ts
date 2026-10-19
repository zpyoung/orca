import type { HostOperationOwnership } from '../host-operation-ownership'

/** Loop RPC names are colon-separated, so the namespace table never sees them; a loop runs on
 *  the host that owns its worktree. */
export function loopsHostOperationOwnership(method: string): HostOperationOwnership | null {
  return method.startsWith('loops:') ? 'host' : null
}
