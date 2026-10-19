import type { HostOperationOwnership } from '../host-operation-ownership'

const HEIMDALL_STREAM_METHODS: ReadonlySet<string> = new Set([
  'heimdall:subscribe',
  'heimdall:unsubscribe'
])

/** Heimdall's RPC names are colon-separated, so the namespace table never sees them; the
 *  watcher kernel lives on the host that owns the supervised work. */
export function heimdallHostOperationOwnership(method: string): HostOperationOwnership | null {
  if (!method.startsWith('heimdall:')) {
    return null
  }
  return HEIMDALL_STREAM_METHODS.has(method) ? 'stream' : 'host'
}
