import { ipcRenderer } from 'electron'
import { runtimeApi } from '../api/runtime-bridge'
import { HEIMDALL_CHANNELS, type HeimdallApi } from '../../shared/fork-heimdall/api'
import {
  HEIMDALL_FLEET_CHANGED_CHANNEL,
  type HeimdallFleetSnapshot
} from '../../shared/fork-heimdall/fleet-types'

async function call<TResult>(method: string, params: unknown = {}): Promise<TResult> {
  const response = await runtimeApi.call({ method, params })
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return response.result as TResult
}

export function buildForkHeimdallApi(): HeimdallApi {
  return {
    enroll: (input, owner) => call(HEIMDALL_CHANNELS.enroll, { input, owner: owner ?? null }),
    fleet: () => call(HEIMDALL_CHANNELS.fleet),
    detail: (target) => call(HEIMDALL_CHANNELS.detail, target),
    objectiveDetail: (target) => call(HEIMDALL_CHANNELS.objectiveDetail, target),
    command: (request) => call(HEIMDALL_CHANNELS.command, request),
    debugReport: (target) => call(HEIMDALL_CHANNELS.debugReport, target),
    onFleetChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, snapshot: HeimdallFleetSnapshot): void =>
        callback(snapshot)
      ipcRenderer.on(HEIMDALL_FLEET_CHANGED_CHANNEL, listener)
      return () => ipcRenderer.removeListener(HEIMDALL_FLEET_CHANGED_CHANNEL, listener)
    }
  }
}
