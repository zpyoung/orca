import { Notification } from 'electron'
import type { HostedReviewSitterDefinition } from '../../shared/fork-hosted-review-sitter/types'
import type { NotificationDispatchRequest } from '../../shared/notification-settings-types'
import { deliverNativeNotification } from '../ipc/native-notification-delivery'
import type { Store } from '../persistence'

export function notifyHostedReviewSitter(
  store: Store,
  definition: HostedReviewSitterDefinition,
  title: string,
  body: string,
  notificationId: string
): void {
  const settings = store.getSettings().notifications
  if (!settings.enabled || !Notification.isSupported()) {
    return
  }
  const args: NotificationDispatchRequest = {
    source: 'agent-task-complete',
    notificationId: `hosted-review-sitter:${notificationId}`,
    worktreeId: definition.worktreeId,
    worktreeLabel: definition.branch,
    repoLabel: definition.repoId,
    isActiveWorktree: false
  }
  try {
    void Promise.resolve(deliverNativeNotification(args, { title, body }, settings)).catch(
      (error) => {
        console.warn('[hosted-review-sitter] notification failed:', error)
      }
    )
  } catch (error) {
    console.warn('[hosted-review-sitter] notification failed:', error)
  }
}
