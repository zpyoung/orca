import type { PaneFocusOwnership } from '../pane-helpers'
import {
  hasTerminalDockControllerBridge,
  terminalDockPaneOwnsFocus
} from './terminal-dock-controller-bridge'

/** Yields no argument at all when the tab has no dock, so the call keeps upstream's
 *  single-argument shape rather than passing an ownership that owns nothing. */
export function paneFocusOwnershipArgs(tabId: string): [] | [PaneFocusOwnership] {
  if (!hasTerminalDockControllerBridge(tabId)) {
    return []
  }
  return [
    {
      tabId,
      paneDockOwnsFocus: (paneKey) => terminalDockPaneOwnsFocus(tabId, paneKey)
    }
  ]
}
