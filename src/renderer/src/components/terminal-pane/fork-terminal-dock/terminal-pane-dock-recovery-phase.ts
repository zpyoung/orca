import type { PtyTransportRecoveryState } from '../pty-transport-types'

/** Tracks the raw, unfiltered transport phase per pane for the dock's disabled-reason
 *  resolver — unlike terminal-remote-runtime-recovery-ui-state.ts, which is the recovery
 *  banner's presentation filter and deliberately drops phases the banner has no UI for
 *  (connecting, offline, ended, disposed). Those dropped phases are exactly the ones where
 *  sending would be unsafe, so the dock needs every phase, not the banner's subset. */
export function updateTerminalDockRawRecoveryPhaseByPaneId(
  previous: Record<number, PtyTransportRecoveryState['phase']>,
  paneId: number,
  state: PtyTransportRecoveryState | null
): Record<number, PtyTransportRecoveryState['phase']> {
  if (!state) {
    if (!(paneId in previous)) {
      return previous
    }
    const next = { ...previous }
    delete next[paneId]
    return next
  }
  if (previous[paneId] === state.phase) {
    return previous
  }
  return { ...previous, [paneId]: state.phase }
}
