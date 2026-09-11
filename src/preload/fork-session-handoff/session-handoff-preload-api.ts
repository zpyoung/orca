import { ipcRenderer } from 'electron'
import type { ForkSessionHandoffLineageRecord } from '../../shared/fork-session-handoff/session-lineage-types'
import type {
  ForkHandoffTranscriptProbeRequest,
  ForkHandoffTranscriptProbeResult
} from '../../shared/fork-session-handoff/session-transcript-probe-types'

export type ForkSessionHandoffLineageEnrichArgs = {
  recordId: string
  paneKey?: string | null
  providerSessionId?: string | null
}

export type ForkSessionHandoffPreloadApi = {
  lineageList: () => Promise<ForkSessionHandoffLineageRecord[]>
  lineageRecord: (record: ForkSessionHandoffLineageRecord) => Promise<void>
  lineageEnrich: (args: ForkSessionHandoffLineageEnrichArgs) => Promise<void>
  resolveTranscript: (
    request: ForkHandoffTranscriptProbeRequest
  ) => Promise<ForkHandoffTranscriptProbeResult>
}

/** Build typed renderer wrappers for the session handoff lineage IPC channels. */
export function buildForkSessionHandoffApi(): ForkSessionHandoffPreloadApi {
  return {
    lineageList: () => ipcRenderer.invoke('forkSessionHandoff:lineageList'),
    lineageRecord: (record) => ipcRenderer.invoke('forkSessionHandoff:lineageRecord', record),
    lineageEnrich: (args) => ipcRenderer.invoke('forkSessionHandoff:lineageEnrich', args),
    resolveTranscript: (request) =>
      ipcRenderer.invoke('forkSessionHandoff:resolveTranscript', request)
  }
}
