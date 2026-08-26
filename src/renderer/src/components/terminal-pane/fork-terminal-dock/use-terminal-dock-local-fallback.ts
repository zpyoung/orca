import { useCallback, useRef } from 'react'
import type { TerminalDockPaneState } from '../../../../../shared/fork-terminal-dock/terminal-dock-pane-state'
import { resolveTerminalDockPaneState } from './resolve-terminal-dock-pane-state'
import {
  readTerminalDockPaneState,
  readTerminalDockPaneUserUndocked,
  writeTerminalDockPaneState,
  writeTerminalDockPaneUserUndocked
} from './terminal-dock-pane-state'

export type TerminalDockLocalFallback = {
  /** Resolves a pane's dock state under the echo-precedence rule (see
   *  resolveTerminalDockPaneState): host/store wins once it has ever echoed the field for this
   *  tab, otherwise the client-local copy governs. */
  resolvedStateFor: (
    paneKey: string,
    hostState: TerminalDockPaneState | undefined,
    hostHasEverEchoed: boolean
  ) => TerminalDockPaneState
  /** Whether the user explicitly closed this pane's dock. */
  userUndockedFor: (paneKey: string) => boolean
  /** Records or clears the user decision that suppresses automatic docking. */
  noteUserUndock: (paneKey: string, value: boolean) => void
  /** Write-through target for every dock-state change — keeps the cached copy and the
   *  on-disk copy both current so a later resolution never reads stale data. */
  persistLocalDockState: (paneKey: string, state: TerminalDockPaneState) => void
  /** Drops a retired pane's cached read so the map doesn't grow across a long session. */
  forgetPane: (paneKey: string) => void
}

/** Caches the client-local fallback read once per pane (at first resolution, i.e. mount)
 *  rather than re-reading it live on every render — the host/store side of
 *  resolveTerminalDockPaneState is reactive and, once the host has echoed, always wins anyway,
 *  so a continuous local re-read would only risk a stale write from elsewhere clobbering a live
 *  host value during the window before that first echo. */
export function useTerminalDockLocalFallback(): TerminalDockLocalFallback {
  const cacheRef = useRef<Map<string, TerminalDockPaneState>>(new Map())

  const localFallbackFor = useCallback((paneKey: string): TerminalDockPaneState => {
    const cached = cacheRef.current.get(paneKey)
    if (cached) {
      return cached
    }
    const read = readTerminalDockPaneState(paneKey)
    cacheRef.current.set(paneKey, read)
    return read
  }, [])

  const resolvedStateFor = useCallback(
    (
      paneKey: string,
      hostState: TerminalDockPaneState | undefined,
      hostHasEverEchoed: boolean
    ): TerminalDockPaneState =>
      resolveTerminalDockPaneState(hostState, localFallbackFor(paneKey), hostHasEverEchoed),
    [localFallbackFor]
  )

  const userUndockedFor = useCallback(
    (paneKey: string): boolean => readTerminalDockPaneUserUndocked(paneKey),
    []
  )

  const noteUserUndock = useCallback((paneKey: string, value: boolean): void => {
    writeTerminalDockPaneUserUndocked(paneKey, value)
  }, [])

  const persistLocalDockState = useCallback(
    (paneKey: string, state: TerminalDockPaneState): void => {
      writeTerminalDockPaneState(paneKey, state)
      cacheRef.current.set(paneKey, state)
    },
    []
  )

  const forgetPane = useCallback((paneKey: string): void => {
    cacheRef.current.delete(paneKey)
  }, [])

  return {
    resolvedStateFor,
    userUndockedFor,
    noteUserUndock,
    persistLocalDockState,
    forgetPane
  }
}
