import { ipcRenderer } from 'electron'
import { runtimeApi } from '../api/runtime-bridge'
import { LOOPS_CHANGED_CHANNEL, LOOPS_CHANNELS, type LoopsApi } from '../../shared/fork-loops/api'
import type { LoopSnapshot } from '../../shared/fork-loops/loop-types'

async function call<TResult>(method: string, params: unknown = {}): Promise<TResult> {
  const response = await runtimeApi.call({ method, params })
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: IPC boundary, response.result is unknown; matches the RPC-unwrap pattern used at every runtime:call site in this codebase.
  return response.result as TResult
}

export function buildForkLoopsApi(): LoopsApi {
  return {
    create: (input) => call(LOOPS_CHANNELS.create, input),
    list: (filter) => call(LOOPS_CHANNELS.list, filter ?? {}),
    get: (loopId) => call(LOOPS_CHANNELS.get, { loopId }),
    pause: (loopId, mode) => call(LOOPS_CHANNELS.pause, { loopId, mode }),
    resume: (loopId, opts) => call(LOOPS_CHANNELS.resume, { loopId, ...opts }),
    stop: (loopId, mode) => call(LOOPS_CHANNELS.stop, { loopId, mode }),
    steer: (loopId, text) => call(LOOPS_CHANNELS.steer, { loopId, text }),
    edit: (loopId, patch) => call(LOOPS_CHANNELS.edit, { loopId, patch }),
    queue: (loopId, op) => call(LOOPS_CHANNELS.queue, { loopId, op }),
    bindTab: (loopId, tab) => call(LOOPS_CHANNELS.bindTab, { loopId, ...tab }),
    detach: (loopId) => call(LOOPS_CHANNELS.detach, { loopId }),
    openTab: (loopId) => call(LOOPS_CHANNELS.openTab, { loopId }),
    onChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, snapshot: LoopSnapshot): void =>
        listener(snapshot)
      ipcRenderer.on(LOOPS_CHANGED_CHANNEL, handler)
      return () => ipcRenderer.removeListener(LOOPS_CHANGED_CHANNEL, handler)
    }
  }
}
