import type { ForkSessionHandoffLineageRecord } from '../../../../shared/fork-session-handoff/session-lineage-types'
import type {
  ForkHandoffTranscriptProbeRequest,
  ForkHandoffTranscriptProbeResult
} from '../../../../shared/fork-session-handoff/session-transcript-probe-types'

export type ForkSessionHandoffRendererApi = {
  lineageList: () => Promise<ForkSessionHandoffLineageRecord[]>
  lineageRecord: (record: ForkSessionHandoffLineageRecord) => Promise<void>
  lineageEnrich: (args: {
    recordId: string
    paneKey?: string | null
    providerSessionId?: string | null
  }) => Promise<void>
  resolveTranscript: (
    request: ForkHandoffTranscriptProbeRequest
  ) => Promise<ForkHandoffTranscriptProbeResult>
}

/** Returns the fork-owned session handoff API without widening the upstream preload surface. */
export function getForkSessionHandoffApi(): ForkSessionHandoffRendererApi {
  const api = (
    window.api as typeof window.api & {
      forkSessionHandoff?: ForkSessionHandoffRendererApi
    }
  ).forkSessionHandoff
  if (!api) {
    throw new Error('Session handoff API is unavailable')
  }
  return api
}
