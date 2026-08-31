import { ipcRenderer } from 'electron'
import { FORK_SESSION_INFO_CHANNELS } from '../../shared/fork-session-info/session-info-channels'
import type {
  SessionInfoPaneTelemetry,
  SessionInfoStatusLineChainStatus,
  SessionInfoTelemetrySnapshot
} from '../../shared/fork-session-info/session-info-types'

export type ForkSessionInfoApi = {
  getSnapshot: () => Promise<SessionInfoTelemetrySnapshot>
  onUpdate: (listener: (telemetry: SessionInfoPaneTelemetry) => void) => () => void
  getStatusLineChainStatus: () => Promise<SessionInfoStatusLineChainStatus>
  enableStatusLineChaining: () => Promise<SessionInfoStatusLineChainStatus>
}

/** Build the narrow bridge for pane telemetry and explicit statusline consent. */
export function buildForkSessionInfoApi(): ForkSessionInfoApi {
  let updateSubscriberCount = 0
  return {
    getSnapshot: () => ipcRenderer.invoke(FORK_SESSION_INFO_CHANNELS.snapshot),
    onUpdate: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        telemetry: SessionInfoPaneTelemetry
      ): void => {
        listener(telemetry)
      }
      ipcRenderer.on(FORK_SESSION_INFO_CHANNELS.update, handler)
      updateSubscriberCount += 1
      if (updateSubscriberCount === 1) {
        ipcRenderer.send(FORK_SESSION_INFO_CHANNELS.subscribe)
      }
      let subscribed = true
      return () => {
        if (!subscribed) {
          return
        }
        subscribed = false
        ipcRenderer.removeListener(FORK_SESSION_INFO_CHANNELS.update, handler)
        updateSubscriberCount -= 1
        if (updateSubscriberCount === 0) {
          ipcRenderer.send(FORK_SESSION_INFO_CHANNELS.unsubscribe)
        }
      }
    },
    getStatusLineChainStatus: () => ipcRenderer.invoke(FORK_SESSION_INFO_CHANNELS.chainStatus),
    enableStatusLineChaining: () => ipcRenderer.invoke(FORK_SESSION_INFO_CHANNELS.enableChaining)
  }
}
