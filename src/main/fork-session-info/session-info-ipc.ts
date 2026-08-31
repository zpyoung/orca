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
  ipcMain.handle(FORK_SESSION_INFO_CHANNELS.snapshot, () => service.getSnapshot())
  ipcMain.handle(FORK_SESSION_INFO_CHANNELS.chainStatus, () => chaining.status())
  ipcMain.handle(FORK_SESSION_INFO_CHANNELS.enableChaining, () => chaining.enable())
  ipcMain.on(FORK_SESSION_INFO_CHANNELS.subscribe, (event) => {
    unsubscribeBySenderId.get(event.sender.id)?.()
    const unsubscribe = service.subscribe((telemetry) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(FORK_SESSION_INFO_CHANNELS.update, telemetry)
      }
    })
    unsubscribeBySenderId.set(event.sender.id, unsubscribe)
    event.sender.once('destroyed', () => {
      unsubscribeBySenderId.get(event.sender.id)?.()
      unsubscribeBySenderId.delete(event.sender.id)
    })
  })
  ipcMain.on(FORK_SESSION_INFO_CHANNELS.unsubscribe, (event) => {
    unsubscribeBySenderId.get(event.sender.id)?.()
    unsubscribeBySenderId.delete(event.sender.id)
  })
}
