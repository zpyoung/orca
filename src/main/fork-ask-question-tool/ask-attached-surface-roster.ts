import { ASK_SURFACE_CLIENT_CAPABILITY } from '../../shared/fork-ask-question-tool/ask-question-capability'
import type { RuntimeCapability } from '../../shared/protocol-version'

export type AskAttachedSurfaceRosterHost = {
  /** Same-build local desktop renderer; implicitly ask-capable and owns every local pane. */
  hasLocalRendererWindow(): boolean
}

/** Where a pane losing or regaining its last capable owner is reported, for the ask liveness grace timer (tech.md C2). */
export type AskPaneLivenessSink = {
  notePaneDetached(paneKey: string): void
  notePaneAttached(paneKey: string): void
}

/**
 * Tracks, per live connection, the panes it currently subscribes a terminal view to and the
 * capabilities it advertised at auth — the facts `ask.register`'s capability gate needs to tell
 * whether some attached surface can render an ask for a given pane. Policy (what to do when
 * nobody can) belongs to the caller.
 */
export class AskAttachedSurfaceRoster {
  private readonly capabilitiesByConnection = new Map<string, readonly RuntimeCapability[]>()
  private readonly paneRefcountsByConnection = new Map<string, Map<string, number>>()
  private readonly subscribedPaneByConnectionAndHandle = new Map<string, Map<string, string>>()

  constructor(
    private readonly host: AskAttachedSurfaceRosterHost,
    private readonly livenessSink?: AskPaneLivenessSink
  ) {}

  /** Capabilities gate `hasCapableOwner`, so changing them can flip it for every pane this connection already holds. */
  recordConnectionCapabilities(
    connectionId: string,
    capabilities: readonly RuntimeCapability[]
  ): void {
    const affectedPanes = [...(this.paneRefcountsByConnection.get(connectionId)?.keys() ?? [])]
    const wasCapable = new Map(
      affectedPanes.map((paneKey) => [paneKey, this.hasCapableOwner(paneKey)])
    )
    this.capabilitiesByConnection.set(connectionId, capabilities)
    for (const paneKey of affectedPanes) {
      this.reportOwnershipChange(paneKey, wasCapable.get(paneKey) ?? false)
    }
  }

  /** Drops every pane and capability entry for a connection — the dropped-connection safety net. */
  forgetConnection(connectionId: string): void {
    const affectedPanes = [...(this.paneRefcountsByConnection.get(connectionId)?.keys() ?? [])]
    const wasCapable = new Map(
      affectedPanes.map((paneKey) => [paneKey, this.hasCapableOwner(paneKey)])
    )
    this.capabilitiesByConnection.delete(connectionId)
    this.paneRefcountsByConnection.delete(connectionId)
    this.subscribedPaneByConnectionAndHandle.delete(connectionId)
    for (const paneKey of affectedPanes) {
      this.reportOwnershipChange(paneKey, wasCapable.get(paneKey) ?? false)
    }
  }

  /** Remembers the pane a (connection, terminalHandle) subscription resolved to, so cleanup can find it later. */
  recordSubscribedPane(connectionId: string, terminalHandle: string, paneKey: string): void {
    let handles = this.subscribedPaneByConnectionAndHandle.get(connectionId)
    if (!handles) {
      handles = new Map()
      this.subscribedPaneByConnectionAndHandle.set(connectionId, handles)
    }
    handles.set(terminalHandle, paneKey)
  }

  /**
   * Pops the pane key recorded for a (connection, terminalHandle) subscription. Cleanup must go
   * through this rather than re-resolving the handle, because a terminal already torn down by
   * the time cleanup runs no longer resolves (F6) and would otherwise leave a phantom owner.
   */
  takeSubscribedPane(connectionId: string, terminalHandle: string): string | undefined {
    const handles = this.subscribedPaneByConnectionAndHandle.get(connectionId)
    const paneKey = handles?.get(terminalHandle)
    if (!handles || paneKey === undefined) {
      return undefined
    }
    handles.delete(terminalHandle)
    if (handles.size === 0) {
      this.subscribedPaneByConnectionAndHandle.delete(connectionId)
    }
    return paneKey
  }

  trackPaneSubscription(connectionId: string, paneKey: string): void {
    const wasCapable = this.hasCapableOwner(paneKey)
    let panes = this.paneRefcountsByConnection.get(connectionId)
    if (!panes) {
      panes = new Map()
      this.paneRefcountsByConnection.set(connectionId, panes)
    }
    panes.set(paneKey, (panes.get(paneKey) ?? 0) + 1)
    this.reportOwnershipChange(paneKey, wasCapable)
  }

  untrackPaneSubscription(connectionId: string, paneKey: string): void {
    const panes = this.paneRefcountsByConnection.get(connectionId)
    const count = panes?.get(paneKey)
    if (!panes || count === undefined) {
      return
    }
    const wasCapable = this.hasCapableOwner(paneKey)
    if (count <= 1) {
      panes.delete(paneKey)
      if (panes.size === 0) {
        this.paneRefcountsByConnection.delete(connectionId)
      }
    } else {
      panes.set(paneKey, count - 1)
    }
    this.reportOwnershipChange(paneKey, wasCapable)
  }

  /** Notifies the liveness sink only on an actual gain/loss of `paneKey`'s last capable owner. */
  private reportOwnershipChange(paneKey: string, wasCapable: boolean): void {
    const isCapable = this.hasCapableOwner(paneKey)
    if (isCapable === wasCapable) {
      return
    }
    if (isCapable) {
      this.livenessSink?.notePaneAttached(paneKey)
    } else {
      this.livenessSink?.notePaneDetached(paneKey)
    }
  }

  /** True when the local renderer, or a live connection that both owns and can render it, holds `paneKey`. */
  hasCapableOwner(paneKey: string): boolean {
    if (this.host.hasLocalRendererWindow()) {
      return true
    }
    for (const [connectionId, panes] of this.paneRefcountsByConnection) {
      if (!panes.has(paneKey)) {
        continue
      }
      if (
        this.capabilitiesByConnection.get(connectionId)?.includes(ASK_SURFACE_CLIENT_CAPABILITY)
      ) {
        return true
      }
    }
    return false
  }
}

export function createAskAttachedSurfaceRoster(
  host: AskAttachedSurfaceRosterHost,
  livenessSink?: AskPaneLivenessSink
): AskAttachedSurfaceRoster {
  return new AskAttachedSurfaceRoster(host, livenessSink)
}

// Why: terminal.subscribe is driven by test doubles and by callers that predate this feature, so
// neither accessor is guaranteed to exist on the runtime handed in; an untracked pane is correct
// there, and throwing would take down an unrelated subscribe path.
type AskSurfacePaneTrackingRuntime = {
  getTerminalPaneKey?: (handle: string) => string | null
  getAskServices?: () => { roster: AskAttachedSurfaceRoster } | undefined
}

// `in` before `typeof`: the cross-version wire harness proxies every unknown member as a
// "missing runtime method" and answers it with a function returning undefined.
function hasRuntimeMethod<K extends keyof AskSurfacePaneTrackingRuntime>(
  runtime: AskSurfacePaneTrackingRuntime,
  name: K
): runtime is AskSurfacePaneTrackingRuntime & Required<Pick<AskSurfacePaneTrackingRuntime, K>> {
  return name in runtime && typeof runtime[name] === 'function'
}

/** The connection-level roster, or null on a runtime (test double, remote proxy) that carries no ask services. */
export function askRosterFor(
  runtime: Pick<AskSurfacePaneTrackingRuntime, 'getAskServices'>
): AskAttachedSurfaceRoster | null {
  return hasRuntimeMethod(runtime, 'getAskServices')
    ? (runtime.getAskServices()?.roster ?? null)
    : null
}

function resolvePaneKeyForHandle(
  runtime: AskSurfacePaneTrackingRuntime,
  terminalHandle: string
): string | null {
  return hasRuntimeMethod(runtime, 'getTerminalPaneKey')
    ? runtime.getTerminalPaneKey(terminalHandle)
    : null
}

function resolveTrackingTarget(
  runtime: AskSurfacePaneTrackingRuntime,
  terminalHandle: string
): { roster: AskAttachedSurfaceRoster; paneKey: string } | null {
  const roster = askRosterFor(runtime)
  const paneKey = roster ? resolvePaneKeyForHandle(runtime, terminalHandle) : null
  return roster && paneKey ? { roster, paneKey } : null
}

export function trackAskSurfacePaneSubscription(
  runtime: AskSurfacePaneTrackingRuntime,
  connectionId: string | undefined,
  terminalHandle: string
): void {
  if (!connectionId) {
    return
  }
  const target = resolveTrackingTarget(runtime, terminalHandle)
  if (target) {
    target.roster.trackPaneSubscription(connectionId, target.paneKey)
    target.roster.recordSubscribedPane(connectionId, terminalHandle, target.paneKey)
  }
}

export function untrackAskSurfacePaneSubscription(
  runtime: AskSurfacePaneTrackingRuntime,
  connectionId: string | undefined,
  terminalHandle: string
): void {
  if (!connectionId) {
    return
  }
  const roster = askRosterFor(runtime)
  if (!roster) {
    return
  }
  const paneKey =
    roster.takeSubscribedPane(connectionId, terminalHandle) ??
    resolvePaneKeyForHandle(runtime, terminalHandle)
  if (paneKey) {
    roster.untrackPaneSubscription(connectionId, paneKey)
  }
}
