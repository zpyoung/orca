/** SSH relay checkpoint support gate: fail-loud preflight, never a silent degrade. */

import type { SshGitProvider } from '../../providers/ssh-git-provider'

export async function assertRelaySupportsPipelineCheckpoints(
  provider: SshGitProvider
): Promise<{ ok: true } | { ok: false; message: string }> {
  let supported: boolean
  try {
    supported = await provider.pipelineCheckpointSupported()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      message: `Could not reach the SSH host to check pipeline checkpoint support: ${detail}`
    }
  }
  if (!supported) {
    return {
      ok: false,
      message:
        'This SSH host is running an older Orca relay that cannot capture pipeline checkpoints. Update the remote Orca on that host, then try again.'
    }
  }
  return { ok: true }
}
