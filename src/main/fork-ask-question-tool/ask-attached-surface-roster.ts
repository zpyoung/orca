import { ASK_SURFACE_CLIENT_CAPABILITY } from '../../shared/fork-ask-question-tool/ask-question-capability'
import type { RuntimeCapability } from '../../shared/protocol-version'

export type AskAttachedSurfaceRosterHost = {
  /** Same-build local desktop renderer; implicitly ask-capable and owns every local pane. */
  hasLocalRendererWindow(): boolean
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

  constructor(private readonly host: AskAttachedSurfaceRosterHost) {}

  recordConnectionCapabilities(
    connectionId: string,
    capabilities: readonly RuntimeCapability[]
  ): void {
    this.capabilitiesByConnection.set(connectionId, capabilities)
  }

  /** Drops every pane and capability entry for a connection — the dropped-connection safety net. */
  forgetConnection(connectionId: string): void {
    this.capabilitiesByConnection.delete(connectionId)
    this.paneRefcountsByConnection.delete(connectionId)
    this.subscribedPaneByConnectionAndHandle.delete(connectionId)
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
    let panes = this.paneRefcountsByConnection.get(connectionId)
    if (!panes) {
      panes = new Map()
      this.paneRefcountsByConnection.set(connectionId, panes)
    }
    panes.set(paneKey, (panes.get(paneKey) ?? 0) + 1)
  }

  untrackPaneSubscription(connectionId: string, paneKey: string): void {
    const panes = this.paneRefcountsByConnection.get(connectionId)
    const count = panes?.get(paneKey)
    if (!panes || count === undefined) {
      return
    }
    if (count <= 1) {
      panes.delete(paneKey)
      if (panes.size === 0) {
        this.paneRefcountsByConnection.delete(connectionId)
      }
    } else {
      panes.set(paneKey, count - 1)
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
      if (this.capabilitiesByConnection.get(connectionId)?.includes(ASK_SURFACE_CLIENT_CAPABILITY)) {
        return true
      }
    }
    return false
  }
}

export function createAskAttachedSurfaceRoster(
  host: AskAttachedSurfaceRosterHost
): AskAttachedSurfaceRoster {
  return new AskAttachedSurfaceRoster(host)
}

type AskSurfacePaneTrackingRuntime = {
  getTerminalPaneKey(handle: string): string | null
  getAskServices(): { roster: AskAttachedSurfaceRoster }
}

export function trackAskSurfacePaneSubscription(
  runtime: AskSurfacePaneTrackingRuntime,
  connectionId: string | undefined,
  terminalHandle: string
): void {
  if (!connectionId) {
    return
  }
  const paneKey = runtime.getTerminalPaneKey(terminalHandle)
  if (paneKey) {
    const roster = runtime.getAskServices().roster
    roster.trackPaneSubscription(connectionId, paneKey)
    roster.recordSubscribedPane(connectionId, terminalHandle, paneKey)
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
  const roster = runtime.getAskServices().roster
  const paneKey = roster.takeSubscribedPane(connectionId, terminalHandle) ?? runtime.getTerminalPaneKey(terminalHandle)
  if (paneKey) {
    roster.untrackPaneSubscription(connectionId, paneKey)
  }
}
