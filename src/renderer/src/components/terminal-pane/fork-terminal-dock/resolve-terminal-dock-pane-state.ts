import type { TerminalDockPaneState } from '../../../../../shared/types'
import { DEFAULT_TERMINAL_DOCK_PANE_STATE } from './terminal-dock-pane-state'

/** Resolves a pane's dock state under the echo-precedence rule: once the host has ever echoed
 *  `terminalDockByPaneKey` for this tab, it's authoritative (old-host wire skew is gone, so the
 *  locally persisted copy must not shadow a live host value); until then the client-local
 *  fallback governs so state survives a restart against a host that strips the field. */
export function resolveTerminalDockPaneState(
  hostState: TerminalDockPaneState | undefined,
  localState: TerminalDockPaneState | undefined,
  hostHasEverEchoed: boolean
): TerminalDockPaneState {
  const state = hostHasEverEchoed ? hostState : localState
  return state ?? DEFAULT_TERMINAL_DOCK_PANE_STATE
}
