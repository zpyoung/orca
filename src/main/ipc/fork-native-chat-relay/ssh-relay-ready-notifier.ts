// Per-target "this SSH relay reached ready" fan-out.
//
// Subscribers that hold relay-side state (native chat's transcript watcher) must
// re-establish it after a reconnect, and a reconnect can replace the
// SshRelaySession object outright — so the registry is keyed by target id here
// rather than held on the session it has to outlive.

const readyHandlersByTarget = new Map<string, Set<() => void>>()

/** Fires on every ready, including reconnects. Returns an unregister fn. */
export function onSshRelayReady(targetId: string, handler: () => void): () => void {
  const handlers = readyHandlersByTarget.get(targetId) ?? new Set<() => void>()
  handlers.add(handler)
  readyHandlersByTarget.set(targetId, handlers)
  return () => {
    const current = readyHandlersByTarget.get(targetId)
    if (!current) {
      return
    }
    current.delete(handler)
    if (current.size === 0) {
      readyHandlersByTarget.delete(targetId)
    }
  }
}

export function notifySshRelayReady(targetId: string): void {
  const handlers = readyHandlersByTarget.get(targetId)
  if (!handlers) {
    return
  }
  // Copied: a handler may unregister itself while re-establishing.
  for (const handler of Array.from(handlers)) {
    handler()
  }
}

/** Test-only: drop every registration between runs. */
export function clearSshRelayReadyHandlers(): void {
  readyHandlersByTarget.clear()
}
