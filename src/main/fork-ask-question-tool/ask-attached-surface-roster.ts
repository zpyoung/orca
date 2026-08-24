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
    runtime.getAskServices().roster.trackPaneSubscription(connectionId, paneKey)
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
  const paneKey = runtime.getTerminalPaneKey(terminalHandle)
  if (paneKey) {
    runtime.getAskServices().roster.untrackPaneSubscription(connectionId, paneKey)
  }
}
