import { hasUnsafeProviderSessionIdChars } from '../agent-session-resume'

/** Request and verdict shapes for the handoff transcript probe, shared by the
 *  renderer probe, the preload wrapper, and the main-process resolver. */

export type ForkHandoffTranscriptProbeRequest = {
  agent: string | null
  sessionId: string | null
  transcriptPath: string | null
  /** Source pane, used to recover a transcript the pane reported before its agent
   *  rotated to a session id with no file of its own. */
  paneKey: string | null
  /** Source working directory, used only by the last-resort project-bucket scan. */
  workspacePath: string | null
  /** SSH target owning the transcript disk, when source and target both run
   *  there. Null means this host. */
  connectionId: string | null
}

/** How the returned path was located. Anything past `reported` means the agent's
 *  own pointer had gone stale, and `project-scan` is a recovered best match
 *  rather than a path the agent ever named. */
export type ForkHandoffTranscriptProvenance =
  | 'reported'
  | 'session-id'
  | 'pane-history'
  | 'project-scan'

/** `unverifiable` is never "absent": it means the probe could not decide, so the
 *  caller must not report the transcript as missing. */
export type ForkHandoffTranscriptProbeResult =
  | { outcome: 'found'; transcriptPath: string; provenance: ForkHandoffTranscriptProvenance }
  | { outcome: 'missing' }
  | { outcome: 'unverifiable'; reason: ForkHandoffTranscriptProbeFailure }

export type ForkHandoffTranscriptProbeFailure =
  | 'invalid-request'
  | 'unsupported-agent'
  | 'path-outside-known-roots'
  | 'undiscoverable-path'
  | 'resolve-failed'
  | 'stat-failed'
  | 'host-unavailable'
  | 'ambiguous-project-scan'

export function parseForkHandoffTranscriptProbeRequest(
  value: unknown
): ForkHandoffTranscriptProbeRequest | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const record = value as Record<string, unknown>
  const agent = readProbeString(record.agent)
  const sessionId = readProbeString(record.sessionId)
  const transcriptPath = readProbeString(record.transcriptPath)
  if (!agent || (!sessionId && !transcriptPath)) {
    return null
  }
  return {
    agent,
    sessionId,
    transcriptPath,
    paneKey: readProbeString(record.paneKey),
    workspacePath: readProbeString(record.workspacePath),
    connectionId: readProbeString(record.connectionId)
  }
}

function readProbeString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  // A NUL would throw inside fs rather than reject as invalid input.
  return trimmed && !hasUnsafeProviderSessionIdChars(trimmed) ? trimmed : null
}
