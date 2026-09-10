import type { PtyTransportRecoveryState } from '../pty-transport-types'

/**
 * Publishes the dock's controller-facing surface for one terminal tab.
 *
 * Upstream's TerminalPane is a barrel over a staged controller chain whose files are pinned by
 * exact hook-order and listener-order parity tests, so the dock's own hooks cannot live there.
 * They run in TerminalPaneSurface instead, and the chain reads them back through this registry at
 * call time — every entry point below is a plain function, never a hook.
 *
 * The controller renders before the Surface mounts, so every lookup must tolerate an absent
 * bridge and fall through to upstream behavior.
 */
export type TerminalDockControllerBridge = {
  paneDockOwnsFocus: (paneKey: string) => boolean
  notePanePtyBindingChanged: () => void
  undockOnConfirmedAgentExit: (leafId: string) => void
  prunePassthroughForRetiredPane: (leafId: string) => void
}

const bridgeByTabId = new Map<string, TerminalDockControllerBridge>()

export function registerTerminalDockControllerBridge(
  tabId: string,
  bridge: TerminalDockControllerBridge
): () => void {
  bridgeByTabId.set(tabId, bridge)
  return () => {
    if (bridgeByTabId.get(tabId) === bridge) {
      bridgeByTabId.delete(tabId)
    }
  }
}

/** Whether a Surface has published a dock for this tab yet. */
export function hasTerminalDockControllerBridge(tabId: string): boolean {
  return bridgeByTabId.has(tabId)
}

export function terminalDockPaneOwnsFocus(tabId: string, paneKey: string): boolean {
  return bridgeByTabId.get(tabId)?.paneDockOwnsFocus(paneKey) ?? false
}

export function noteTerminalDockPanePtyBindingChanged(tabId: string): void {
  bridgeByTabId.get(tabId)?.notePanePtyBindingChanged()
}

export function notifyTerminalDockConfirmedAgentExit(tabId: string, leafId: string): void {
  bridgeByTabId.get(tabId)?.undockOnConfirmedAgentExit(leafId)
}

export function notifyTerminalDockPaneRetired(tabId: string, leafId: string): void {
  bridgeByTabId.get(tabId)?.prunePassthroughForRetiredPane(leafId)
}

/**
 * The dock's disabled-reason resolver needs every recovery phase (offline, ended, disposed,
 * connecting included). The controller's own recovery state is the banner's filtered view and must
 * not be widened, so the raw phase is published here and the Surface subscribes.
 */
type RawRecoveryPhaseByPaneId = Readonly<Record<number, PtyTransportRecoveryState['phase']>>

const EMPTY_RAW_PHASES: RawRecoveryPhaseByPaneId = {}
const rawPhasesByTabId = new Map<string, RawRecoveryPhaseByPaneId>()
const rawPhaseListenersByTabId = new Map<string, Set<() => void>>()

export function publishTerminalDockRawRecoveryPhase(
  tabId: string,
  next: (previous: RawRecoveryPhaseByPaneId) => RawRecoveryPhaseByPaneId
): void {
  const previous = rawPhasesByTabId.get(tabId) ?? EMPTY_RAW_PHASES
  const resolved = next(previous)
  if (resolved === previous) {
    return
  }
  rawPhasesByTabId.set(tabId, resolved)
  for (const listener of rawPhaseListenersByTabId.get(tabId) ?? []) {
    listener()
  }
}

export function getTerminalDockRawRecoveryPhases(tabId: string): RawRecoveryPhaseByPaneId {
  return rawPhasesByTabId.get(tabId) ?? EMPTY_RAW_PHASES
}

export function subscribeTerminalDockRawRecoveryPhases(
  tabId: string,
  listener: () => void
): () => void {
  let listeners = rawPhaseListenersByTabId.get(tabId)
  if (!listeners) {
    listeners = new Set()
    rawPhaseListenersByTabId.set(tabId, listeners)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      rawPhaseListenersByTabId.delete(tabId)
      rawPhasesByTabId.delete(tabId)
    }
  }
}
