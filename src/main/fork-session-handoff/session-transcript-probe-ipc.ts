import { ipcMain } from 'electron'
import {
  parseForkHandoffTranscriptProbeRequest,
  type ForkHandoffTranscriptProbeResult
} from '../../shared/fork-session-handoff/session-transcript-probe-types'
import { resolveHandoffTranscript } from './session-transcript-probe'

export const FORK_SESSION_HANDOFF_TRANSCRIPT_CHANNEL = 'forkSessionHandoff:resolveTranscript'

type ResolveTranscript = typeof resolveHandoffTranscript

/** Register the validated transcript probe channel used by the handoff dialog. */
export function registerForkSessionHandoffTranscriptProbe(
  resolveTranscript: ResolveTranscript = resolveHandoffTranscript
): void {
  ipcMain.handle(
    FORK_SESSION_HANDOFF_TRANSCRIPT_CHANNEL,
    async (_event, value: unknown): Promise<ForkHandoffTranscriptProbeResult> => {
      const request = parseForkHandoffTranscriptProbeRequest(value)
      if (!request) {
        return { outcome: 'unverifiable', reason: 'invalid-request' }
      }
      return resolveTranscript(request)
    }
  )
}
