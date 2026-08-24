import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { getWorktreeMapFromState } from '@/store/selectors'
import { translate } from '@/i18n/i18n'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { isTerminalAskStatus, type AskStatus } from '../../../../shared/fork-ask-question-tool/ask-answer-envelope'
import {
  isOrcaWindowForegroundFocused,
  isVisibleForegroundPaneKey
} from '../terminal-pane/terminal-notification-pane-visibility'

/** How long a pending ask waits on an unfocused pane before escalating to an OS notification. */
export const ASK_NOTIFICATION_ESCALATION_DELAY_MS = 3 * 60_000

export type UseAskNotificationEscalationParams = {
  askId: string | null
  status: AskStatus | null
  worktreeId: string
  paneKey: string
}

function isAskPaneFocused(worktreeId: string, paneKey: string): boolean {
  return (
    isOrcaWindowForegroundFocused() &&
    isVisibleForegroundPaneKey(useAppStore.getState(), worktreeId, paneKey)
  )
}

function dispatchAskEscalationNotification(worktreeId: string, paneKey: string, askId: string): void {
  const state = useAppStore.getState()
  const worktree = getWorktreeMapFromState(state).get(worktreeId)
  const worktreeLabel = worktree?.displayName ?? worktreeId
  void window.api.notifications
    .dispatch({
      source: 'pending-ask',
      notificationId: `ask-pending-${askId}`,
      worktreeId,
      paneKey,
      isActiveWorktree: state.activeWorktreeId === worktreeId,
      title: translate(
        'components.fork-ask-question-tool.notification.title',
        'Pending question in {{worktreeLabel}}',
        { worktreeLabel }
      ),
      body: translate(
        'components.fork-ask-question-tool.notification.body',
        'Waiting for your answer.'
      )
    })
    .catch((err) => {
      console.warn('Failed to dispatch ask escalation notification:', err)
    })
}

/**
 * Arms an OS-notification escalation for a pending ask while its owning pane is unfocused, per
 * tech.md § C8 (Notification escalation). Focusing the pane, the ask resolving, or the ask
 * changing all cancel any in-flight timer.
 */
export function useAskNotificationEscalation({
  askId,
  status,
  worktreeId,
  paneKey
}: UseAskNotificationEscalationParams): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const armedAskIdRef = useRef<string | null>(null)
  const [focusTick, setFocusTick] = useState(0)

  useEffect(() => {
    const bump = (): void => setFocusTick((tick) => tick + 1)
    window.addEventListener('focus', bump)
    window.addEventListener('blur', bump)
    document.addEventListener('visibilitychange', bump)
    return () => {
      window.removeEventListener('focus', bump)
      window.removeEventListener('blur', bump)
      document.removeEventListener('visibilitychange', bump)
    }
  }, [])

  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const activeLeafId = useAppStore((s) => {
    const parsed = parsePaneKey(paneKey)
    return parsed ? s.terminalLayoutsByTabId?.[parsed.tabId]?.activeLeafId : undefined
  })

  useEffect(() => {
    function disarm(): void {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      armedAskIdRef.current = null
    }

    const isPending = askId !== null && status !== null && !isTerminalAskStatus(status)
    if (!isPending || askId === null || isAskPaneFocused(worktreeId, paneKey)) {
      disarm()
      return
    }
    if (armedAskIdRef.current === askId) {
      return
    }
    disarm()
    armedAskIdRef.current = askId
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      // arming and firing are separate decisions: the pane may have regained focus during the
      // delay, and only a fresh check here (not the state captured at arm time) catches that
      if (!isAskPaneFocused(worktreeId, paneKey)) {
        dispatchAskEscalationNotification(worktreeId, paneKey, askId)
      }
    }, ASK_NOTIFICATION_ESCALATION_DELAY_MS)

    return disarm
  }, [askId, status, worktreeId, paneKey, activeWorktreeId, activeTabId, activeLeafId, focusTick])
}
