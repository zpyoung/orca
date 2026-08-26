import { normalizeExecutionHostId } from '../../../../shared/execution-host'
import type { HandoffTargetResolution } from './handoff-target-resolution'
import { resolveHandoffTargetExecutionHostId } from './handoff-target-resolution'

export type HandoffTranscriptReachability = 'usable' | 'unreachable' | 'none'

/** Verifies that a host-local transcript exists on the selected execution host. */
export async function resolveTranscriptReachability(args: {
  transcriptPath: string | null
  sourceExecutionHostId: string | null
  target: HandoffTargetResolution
}): Promise<HandoffTranscriptReachability> {
  const transcriptPath = args.transcriptPath?.trim()
  if (!transcriptPath) {
    return 'none'
  }
  if (args.target.runtimeEnvironmentId) {
    return 'unreachable'
  }

  const sourceHostId = normalizeExecutionHostId(args.sourceExecutionHostId)
  const targetHostId = resolveHandoffTargetExecutionHostId(args.target)
  if (!sourceHostId || sourceHostId !== targetHostId) {
    return 'unreachable'
  }

  try {
    const exists = await window.api.fs.pathExists({
      filePath: transcriptPath,
      ...(args.target.sshConnectionId ? { connectionId: args.target.sshConnectionId } : {})
    })
    return exists ? 'usable' : 'unreachable'
  } catch {
    return 'unreachable'
  }
}
