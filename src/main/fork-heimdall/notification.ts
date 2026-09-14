import * as electron from 'electron'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import type { NotificationDispatchRequest } from '../../shared/notification-settings-types'
import { deliverNativeNotification } from '../ipc/native-notification-delivery'
import type { Store } from '../persistence'

/** Phase 1 emits only rare approval and terminal notifications. */
export function notifyWatcher(
  store: Pick<Store, 'getSettings'>,
  enrollment: WatcherEnrollment,
  title: string,
  body: string,
  notificationId: string
): void {
  if (!('Notification' in electron) || typeof electron.Notification?.isSupported !== 'function') {
    return
  }
  const settings = store.getSettings().notifications
  if (!settings.enabled || !electron.Notification.isSupported()) {
    return
  }
  const args: NotificationDispatchRequest = {
    source: 'agent-task-complete',
    notificationId: `heimdall:${notificationId}`,
    ...(enrollment.worktreeId ? { worktreeId: enrollment.worktreeId } : {}),
    worktreeLabel: enrollment.workspacePath,
    repoLabel: enrollment.repoId,
    isActiveWorktree: false
  }
  try {
    void Promise.resolve(deliverNativeNotification(args, { title, body }, settings)).catch(
      (error) => {
        console.warn('[heimdall] notification failed:', error)
      }
    )
  } catch (error) {
    console.warn('[heimdall] notification failed:', error)
  }
}
