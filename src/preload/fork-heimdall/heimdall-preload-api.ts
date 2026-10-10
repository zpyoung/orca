import { ipcRenderer } from 'electron'
import { runtimeApi } from '../api/runtime-bridge'
import { HEIMDALL_CHANNELS, type HeimdallApi } from '../../shared/fork-heimdall/api'
import { HEIMDALL_FLEET_CHANGED_CHANNEL } from '../../shared/fork-heimdall/fleet-types'
import type {
  EnrollSuccessReader,
  HeimdallFleetSnapshotReader,
  WatcherDetailReader
} from '../../shared/fork-heimdall/remote-reader-schemas'
import type {
  PipelineEnsureTrackedResponse,
  PipelineListResponse,
  PipelinePersonalResponse,
  PipelineResolveResponse,
  PipelineRunViewResponse
} from '../../shared/fork-heimdall-pipeline/rpc-schemas'

async function call<TResult>(method: string, params: unknown = {}): Promise<TResult> {
  const response = await runtimeApi.call({ method, params })
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: IPC boundary, response.result is unknown; matches the RPC-unwrap pattern used at every runtime:call site in this codebase.
  return response.result as TResult
}

export function buildForkHeimdallApi(): HeimdallApi {
  return {
    enroll: (input, owner) =>
      call<EnrollSuccessReader>(HEIMDALL_CHANNELS.enroll, { input, owner: owner ?? null }),
    fleet: () => call<HeimdallFleetSnapshotReader>(HEIMDALL_CHANNELS.fleet),
    detail: (target) => call<WatcherDetailReader>(HEIMDALL_CHANNELS.detail, target),
    pipelineList: (request) => call<PipelineListResponse>(HEIMDALL_CHANNELS.pipelineList, request),
    pipelineResolve: (request) =>
      call<PipelineResolveResponse>(HEIMDALL_CHANNELS.pipelineResolve, request),
    pipelinePersonal: (request) =>
      call<PipelinePersonalResponse>(HEIMDALL_CHANNELS.pipelinePersonal, request),
    pipelineEnsureTracked: (request) =>
      call<PipelineEnsureTrackedResponse>(HEIMDALL_CHANNELS.pipelineEnsureTracked, request),
    pipelineRunView: (target) =>
      call<PipelineRunViewResponse>(HEIMDALL_CHANNELS.pipelineRunView, { target }),
    command: (request) => call(HEIMDALL_CHANNELS.command, request),
    debugReport: (target) => call(HEIMDALL_CHANNELS.debugReport, target),
    onFleetChanged: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        snapshot: HeimdallFleetSnapshotReader
      ): void => callback(snapshot)
      ipcRenderer.on(HEIMDALL_FLEET_CHANGED_CHANNEL, listener)
      return () => ipcRenderer.removeListener(HEIMDALL_FLEET_CHANGED_CHANNEL, listener)
    }
  }
}
