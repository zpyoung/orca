import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { selectHeadAsk } from '@/store/slices/fork-ask-question-tool/asks'
import type { ActiveRightSidebarTab } from '@/store/slices/editor'
import { isTerminalAskStatus } from '../../../../../shared/fork-ask-question-tool/ask-answer-envelope'
import type { ActivityBarItem } from '../activity-bar-buttons'
import { useFocusedPaneKey } from '../fork-session-info/focused-session-info'

export const ASK_PANEL_TAB = 'ask' satisfies ActiveRightSidebarTab

/**
 * Points the right sidebar at the Questions panel while the focused session has an unanswered
 * ask, and gives it back when the ask resolves.
 *
 * The override is layered over the routed tab rather than written to `rightSidebarTab` on
 * purpose: that field is persisted to disk and mirrored to paired mobile/web clients, and the
 * sidebar already renders a fallback for a hidden tab "without overwriting the stored route"
 * (use-right-sidebar-tab-routing.ts). Leaving the stored route alone makes the hand-back exact
 * and free — once the item is gone the routed tab is whatever the user last chose.
 *
 * Must be called on the routing hook's *result*, never inside it: that hook copies its own
 * effective tab into the folder-workspace memory, which `'ask'` has no business entering.
 */
export function useAskPanelFocus(
  routedTab: ActiveRightSidebarTab,
  visibleItems: readonly Pick<ActivityBarItem, 'id'>[]
): ActiveRightSidebarTab {
  const paneKey = useFocusedPaneKey()
  const headAsk = useAppStore((state) => selectHeadAsk(state, paneKey))
  const routeRequestId = useAppStore((state) => state.rightSidebarRouteRequestId)
  const setRightSidebarOpen = useAppStore((state) => state.setRightSidebarOpen)
  const setAskFocusRestoreOpen = useAppStore((state) => state.setAskFocusRestoreOpen)
  const sidebarOpen = useAppStore((state) => state.rightSidebarOpen)
  const restoreOpen = useAppStore((state) => state.askFocusRestoreOpen)

  const askId = headAsk?.askId ?? null
  const isAwaitingAnswer = headAsk !== null && !isTerminalAskStatus(headAsk.status)
  const itemVisible = visibleItems.some((item) => item.id === ASK_PANEL_TAB)

  const [latchedAskId, setLatchedAskId] = useState<string | null>(null)
  // A set, not one id: with a question waiting on two panes, dismissing the second would
  // otherwise overwrite the first and re-steal focus the moment you switched back to it.
  const dismissedAskIdsRef = useRef<Set<string>>(new Set())
  const lastRouteRequestIdRef = useRef(routeRequestId)

  // Why the nonce and not `rightSidebarTab`: with the override showing Questions over a stored
  // Explorer route, clicking Explorer re-sets a value that is already current and changes no
  // state. `setRightSidebarTab` bumps this counter unconditionally, so it is the only reliable
  // signal that the user made a deliberate choice.
  useEffect(() => {
    if (routeRequestId === lastRouteRequestIdRef.current) {
      return
    }
    lastRouteRequestIdRef.current = routeRequestId
    if (latchedAskId !== null) {
      dismissedAskIdsRef.current.add(latchedAskId)
      setLatchedAskId(null)
    }
  }, [routeRequestId, latchedAskId])

  useEffect(() => {
    if (!isAwaitingAnswer || askId === null || !itemVisible) {
      return
    }
    if (dismissedAskIdsRef.current.has(askId) || latchedAskId === askId) {
      return
    }
    setLatchedAskId(askId)
  }, [askId, isAwaitingAnswer, itemVisible, latchedAskId])

  useEffect(() => {
    if (latchedAskId === null || (itemVisible && latchedAskId === askId)) {
      return
    }
    setLatchedAskId(null)
  }, [askId, itemVisible, latchedAskId])

  const latched = itemVisible && latchedAskId !== null && latchedAskId === askId

  // Read through refs, not deps: a manual collapse while the panel holds focus should stick, and
  // re-running this on every `rightSidebarOpen` change would reopen it under the user.
  const sidebarOpenRef = useRef(sidebarOpen)
  const restoreOpenRef = useRef(restoreOpen)
  sidebarOpenRef.current = sidebarOpen
  restoreOpenRef.current = restoreOpen

  useEffect(() => {
    if (latched) {
      if (!sidebarOpenRef.current && restoreOpenRef.current === null) {
        setAskFocusRestoreOpen(false)
        setRightSidebarOpen(true)
      }
      return
    }
    // `false` is the only value this hook ever stores, so it is also the only one it undoes.
    if (restoreOpenRef.current === false) {
      setRightSidebarOpen(false)
      setAskFocusRestoreOpen(null)
    }
  }, [latched, setAskFocusRestoreOpen, setRightSidebarOpen])

  return latched ? ASK_PANEL_TAB : routedTab
}
