/** Executing-host resolution and the SSH checkpoint-support gate for instantiation preflight. */

import { getSshGitProvider, SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE } from '../../providers/ssh-git-dispatch'
import type { Repo } from '../../../shared/types'
import type { OrcaRuntimeService } from '../orca-runtime'
import { assertRelaySupportsPipelineCheckpoints } from './pipeline-checkpoint-support-gate'
import type { PreflightExecutionHost } from './pipeline-preflight-executable-presence'

/** Native/WSL/SSH host descriptor for the originating workspace's repo, for launch preflight. */
export function resolvePreflightExecutionHost(
  runtime: OrcaRuntimeService,
  repo: Repo,
  worktreeId: string
): PreflightExecutionHost {
  if (repo.connectionId) {
    return { connectionId: repo.connectionId }
  }
  const resolution = runtime.resolveProjectRuntimeForWorktree(worktreeId)
  const wslDistro =
    resolution?.status === 'resolved' && resolution.runtime.kind === 'wsl'
      ? resolution.runtime.distro
      : undefined
  return wslDistro ? { wslDistro } : {}
}

/**
 * SSH-hosted git workspaces must pass the relay checkpoint support gate before anything is
 * persisted, alongside (not after) the per-node launch checks (logic L3, E2 amendment A2).
 */
export async function checkSshCheckpointGate(
  connectionId: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  const provider = getSshGitProvider(connectionId)
  if (!provider) {
    return { ok: false, message: SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE }
  }
  return assertRelaySupportsPipelineCheckpoints(provider)
}
