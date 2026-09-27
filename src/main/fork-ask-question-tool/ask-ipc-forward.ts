import type { BrowserWindow } from 'electron'
import type { AskRegistry, Unsubscribe } from './ask-registry'
import type { AskRegistryEvent } from '../../shared/fork-ask-question-tool/ask-question-schema'

/**
 * Subscribes once to `registry.onAskChanged` and forwards every event to the renderer as
 * `ask:set` (tech.md C8) — the source `window.api.asks.onSet` delivers to the asks slice.
 * Mirrors the `agentStatus:set`/`agentStatus:clear` dual-window send at `src/main/index.ts` so a
 * pane docked in the dashboard popout gets the same cards as the main window.
 */
export function forwardAskEventsToRenderer(
  registry: Pick<AskRegistry, 'onAskChanged'>,
  getMainWindow: () => BrowserWindow | null,
  getDashboardPopoutWindow: () => BrowserWindow | null
): Unsubscribe {
  return registry.onAskChanged((event: AskRegistryEvent) => {
    const mainWindow = getMainWindow()
    if (mainWindow?.isDestroyed()) {
      return
    }
    mainWindow?.webContents.send('ask:set', event)
    // a docked card can live in the popout window, so sending only to mainWindow silently drops it there
    getDashboardPopoutWindow()?.webContents.send('ask:set', event)
  })
}
