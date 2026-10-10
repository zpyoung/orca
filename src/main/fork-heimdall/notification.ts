import * as electron from 'electron'
import type { WatcherDetail } from '../../shared/fork-heimdall/fleet-types'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import type { NotificationDispatchRequest } from '../../shared/notification-settings-types'
import { deliverNativeNotification } from '../ipc/native-notification-delivery'
import type { Store } from '../persistence'
import { approvalNotificationCopy } from '../fork-heimdall-pipeline/approval-notification-copy'

export type WatcherNotificationPublication = 'seed' | 'live' | 'replay'

export type WatcherNotificationTransition = {
  enrollment: WatcherEnrollment
  title: string
  body: string
  notificationId: string
}

export function deriveWatcherNotificationTransitions(
  previous: WatcherDetail | null,
  next: WatcherDetail,
  publication: WatcherNotificationPublication
): WatcherNotificationTransition[] {
  if (
    publication !== 'live' ||
    !previous ||
    previous.watcher.contact !== 'live' ||
    next.watcher.contact !== 'live' ||
    previous.watcher.target.watcherId !== next.watcher.target.watcherId ||
    previous.watcher.target.connectionId !== next.watcher.target.connectionId ||
    previous.watcher.target.pairingRevision !== next.watcher.target.pairingRevision
  ) {
    return []
  }

  const enrollment = next.watcher.entry.enrollment
  const seenEventIds = new Set(previous.ledger.entries.map((entry) => entry.eventId))
  const transitions: WatcherNotificationTransition[] = []
  for (const entry of next.ledger.entries) {
    if (
      !seenEventIds.has(entry.eventId) &&
      entry.kind === 'escalation' &&
      entry.escalationKind === 'awaiting-approval' &&
      entry.status === 'open' &&
      entry.foldCount === 1 &&
      entry.approvalScope
    ) {
      const copy = approvalNotificationCopy(enrollment, {
        kind: entry.approvalScope.actionKind,
        evidenceKey: entry.approvalScope.evidenceKey
      })
      transitions.push({
        enrollment,
        ...copy,
        notificationId: `approval:${entry.eventId}`
      })
    }
  }

  if (
    previous.watcher.entry.status.state !== 'terminal' &&
    next.watcher.entry.status.state === 'terminal'
  ) {
    const terminal = next.ledger.entries
      .toReversed()
      .find((entry) => entry.kind === 'terminal' && !seenEventIds.has(entry.eventId))
    transitions.push({
      enrollment,
      title: 'Watcher reached a terminal state',
      body:
        terminal?.kind === 'terminal'
          ? `${terminal.state}: ${terminal.reason}`
          : (next.watcher.entry.status.reason ?? 'The watcher reached its terminal state.'),
      notificationId: `terminal:${terminal?.eventId ?? `${enrollment.watcherId}:${enrollment.terminalAtMs ?? next.watcher.observedAtMs}`}`
    })
  }
  return transitions
}

export function notifyWatcherDetailTransition(
  store: Pick<Store, 'getSettings'>,
  previous: WatcherDetail | null,
  next: WatcherDetail,
  publication: WatcherNotificationPublication
): void {
  for (const transition of deriveWatcherNotificationTransitions(previous, next, publication)) {
    notifyWatcher(
      store,
      transition.enrollment,
      transition.title,
      transition.body,
      transition.notificationId
    )
  }
}

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
