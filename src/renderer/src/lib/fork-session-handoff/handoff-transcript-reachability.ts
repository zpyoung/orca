import { normalizeExecutionHostId } from '../../../../shared/execution-host'
import type { HandoffTargetResolution } from './handoff-target-resolution'
import { resolveHandoffTargetExecutionHostId } from './handoff-target-resolution'
import { getForkSessionHandoffApi } from './session-handoff-renderer-api'

/** `unverifiable` is not `unreachable`: the probe could not decide, so the
 *  dialog must not tell the user the transcript is absent from the target. */
export type HandoffTranscriptReachability = 'usable' | 'unreachable' | 'unverifiable' | 'none'

export type HandoffTranscriptProbeOutcome = {
  verdict: HandoffTranscriptReachability
  /** The transcript the brief should reference: the host-resolved path when the
   *  probe found one, so a stale or guest-side reported path is corrected. */
  transcriptPath: string | null
}

/** Verifies that a host-local transcript exists on the selected execution host. */
export async function resolveTranscriptReachability(args: {
  agent: string | null
  sessionId: string | null
  transcriptPath: string | null
  paneKey: string | null
  workspacePath: string | null
  sourceExecutionHostId: string | null
  target: HandoffTargetResolution
}): Promise<HandoffTranscriptProbeOutcome> {
  const transcriptPath = args.transcriptPath?.trim() || null
  const sessionId = args.sessionId?.trim() || null
  if (!transcriptPath && !sessionId) {
    return { verdict: 'none', transcriptPath: null }
  }
  // Why 'none' without a reported path: nothing was ever claimed to exist, so
  // reporting it as unreachable would warn about a transcript the source never had.
  const notFound: HandoffTranscriptProbeOutcome = {
    verdict: transcriptPath ? 'unreachable' : 'none',
    transcriptPath: null
  }
  const undecided: HandoffTranscriptProbeOutcome = { verdict: 'unverifiable', transcriptPath: null }
  if (args.target.runtimeEnvironmentId) {
    return notFound
  }

  const sourceHostId = normalizeExecutionHostId(args.sourceExecutionHostId)
  const targetHostId = resolveHandoffTargetExecutionHostId(args.target)
  if (!sourceHostId || sourceHostId !== targetHostId) {
    return notFound
  }

  try {
    // Why not fs.pathExists: its local branch authorizes against the workspace
    // allow-list, and a transcript lives outside every repo — the probe read
    // that refusal as "no transcript". Its SSH branch skips the candidate chain
    // entirely, so a rotated session id never recovers on a remote host.
    const result = await getForkSessionHandoffApi().resolveTranscript({
      agent: args.agent,
      sessionId,
      transcriptPath,
      paneKey: args.paneKey,
      workspacePath: args.workspacePath,
      connectionId: args.target.sshConnectionId ?? null
    })
    if (result.outcome === 'found') {
      return { verdict: 'usable', transcriptPath: result.transcriptPath }
    }
    return result.outcome === 'unverifiable' ? undecided : notFound
  } catch {
    // The probe never answered, so nothing was ruled out.
    return undecided
  }
}
