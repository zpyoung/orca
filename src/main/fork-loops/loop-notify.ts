import * as electron from 'electron'
import type { NotificationDispatchRequest } from '../../shared/notification-settings-types'
import { deliverNativeNotification } from '../ipc/native-notification-delivery'
import type { Store } from '../persistence'

export type LoopNotifyEvent = 'completed' | 'paused' | 'needs-you' | 'cap-reached'

export type LoopNotifySubject = { id: string; name: string; worktreeId: string }

const EVENT_TITLES: Record<LoopNotifyEvent, string> = {
  completed: 'Loop completed',
  paused: 'Loop paused',
  'needs-you': 'Loop needs you',
  'cap-reached': 'Loop reached its cap'
}

export function buildLoopNotification(
  loop: LoopNotifySubject,
  event: LoopNotifyEvent,
  detail?: string
): { title: string; body: string; notificationId: string } {
  return {
    title: EVENT_TITLES[event],
    body: detail ? `${loop.name}: ${detail}` : loop.name,
    notificationId: `loop:${loop.id}:${event}`
  }
}

/** Fire-and-forget native notification, skipped when the user has notifications off. */
export function notifyLoop(
  store: Pick<Store, 'getSettings'>,
  loop: LoopNotifySubject,
  event: LoopNotifyEvent,
  detail?: string
): void {
  if (!('Notification' in electron) || typeof electron.Notification?.isSupported !== 'function') {
    return
  }
  const settings = store.getSettings().notifications
  if (!settings.enabled || !electron.Notification.isSupported()) {
    return
  }
  const { title, body, notificationId } = buildLoopNotification(loop, event, detail)
  const args: NotificationDispatchRequest = {
    source: 'agent-task-complete',
    notificationId,
    worktreeId: loop.worktreeId,
    worktreeLabel: loop.name,
    isActiveWorktree: false
  }
  try {
    void Promise.resolve(deliverNativeNotification(args, { title, body }, settings)).catch(
      (error) => {
        console.warn('[loops] notification failed:', error)
      }
    )
  } catch (error) {
    console.warn('[loops] notification failed:', error)
  }
}
