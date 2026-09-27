import { ipcRenderer } from 'electron'
import type { AskApi } from '../api-types'
import type { AskRegistryEvent } from '../../shared/fork-ask-question-tool/ask-question-schema'
import type { ClaudeSuppressionVerdict } from '../../shared/fork-ask-question-tool/claude-suppression-verdict'

/** Build the ask registry subscription bridge; reads go through `runtime.call('ask.snapshot', …)`. */
export function buildForkAskApi(): AskApi {
  return {
    onSet: (callback: (event: AskRegistryEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: AskRegistryEvent): void => {
        callback(data)
      }
      ipcRenderer.on('ask:set', listener)
      return () => ipcRenderer.removeListener('ask:set', listener)
    },
    getSuppressionVerdict: (): Promise<ClaudeSuppressionVerdict> =>
      ipcRenderer.invoke('ask:suppressionVerdict:get') as Promise<ClaudeSuppressionVerdict>,
    onSuppressionVerdict: (callback: (verdict: ClaudeSuppressionVerdict) => void): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        verdict: ClaudeSuppressionVerdict
      ): void => {
        callback(verdict)
      }
      ipcRenderer.on('ask:suppressionVerdict', listener)
      return () => ipcRenderer.removeListener('ask:suppressionVerdict', listener)
    }
  }
}
