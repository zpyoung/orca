import { ipcMain } from 'electron'
import { FORK_SESSION_INFO_CHANNELS } from '../../shared/fork-session-info/session-info-channels'
import type {
  SessionInfoPaneTelemetry,
  SessionInfoStatusLineChainStatus,
  SessionInfoTelemetrySnapshot
} from '../../shared/fork-session-info/session-info-types'
import {
  enableSessionInfoStatusLineChaining,
  getSessionInfoStatusLineChainStatus
} from './session-info-statusline-chaining'
import { sessionInfoService } from './session-info-service'

type SessionInfoIpcService = {
  getSnapshot: () => SessionInfoTelemetrySnapshot
  subscribe: (listener: (telemetry: SessionInfoPaneTelemetry) => void) => () => void
}

type SessionInfoChaining = {
  status: () => SessionInfoStatusLineChainStatus | Promise<SessionInfoStatusLineChainStatus>
  enable: () => SessionInfoStatusLineChainStatus | Promise<SessionInfoStatusLineChainStatus>
}

/** Register renderer-scoped telemetry push and explicit statusline-consent handlers. */
export function registerSessionInfoIpcHandlers(
  service: SessionInfoIpcService = sessionInfoService,
  chaining: SessionInfoChaining = {
    status: getSessionInfoStatusLineChainStatus,
    enable: enableSessionInfoStatusLineChaining
  }
): void {
  const unsubscribeBySenderId = new Map<number, () => void>()
  const destroyWiredSenderIds = new Set<number>()
  ipcMain.handle(FORK_SESSION_INFO_CHANNELS.snapshot, () => service.getSnapshot())
  ipcMain.handle(FORK_SESSION_INFO_CHANNELS.chainStatus, () => chaining.status())
  ipcMain.handle(FORK_SESSION_INFO_CHANNELS.enableChaining, () => chaining.enable())
  ipcMain.on(FORK_SESSION_INFO_CHANNELS.subscribe, (event) => {
    const senderId = event.sender.id
    unsubscribeBySenderId.get(senderId)?.()
    const unsubscribe = service.subscribe((telemetry) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(FORK_SESSION_INFO_CHANNELS.update, telemetry)
      }
    })
    unsubscribeBySenderId.set(senderId, unsubscribe)
    // resubscribing must not stack another 'destroyed' listener on the same WebContents
    if (!destroyWiredSenderIds.has(senderId)) {
      destroyWiredSenderIds.add(senderId)
      event.sender.once('destroyed', () => {
        unsubscribeBySenderId.get(senderId)?.()
        unsubscribeBySenderId.delete(senderId)
        destroyWiredSenderIds.delete(senderId)
      })
    }
  })
  ipcMain.on(FORK_SESSION_INFO_CHANNELS.unsubscribe, (event) => {
    unsubscribeBySenderId.get(event.sender.id)?.()
    unsubscribeBySenderId.delete(event.sender.id)
  })
}
