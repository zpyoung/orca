import { useCallback, useReducer, useRef } from 'react'

/** Re-renders the dock host when a pane's transport binds or loses its PTY. The transport stays
 *  the source of truth for the id — this only makes the read happen, because the layout-store
 *  write that normally triggers it dedupes a reattach to the id the layout already holds
 *  (terminals.ts setTabLayout), leaving the dock on the null it read while attach was pending. */
export function useTerminalDockPtyBindingRevision(enabled: boolean): () => void {
  const [, bumpRevision] = useReducer((revision: number): number => revision + 1, 0)
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  return useCallback((): void => {
    if (!enabledRef.current) {
      return
    }
    bumpRevision()
  }, [])
}
