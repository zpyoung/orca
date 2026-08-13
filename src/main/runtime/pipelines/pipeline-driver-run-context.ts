/** Resolves the run's dispatch host/worktree once per driver lifetime: never re-derived per cycle. */

import { requireSshGitProvider } from '../../providers/ssh-git-dispatch'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { PipelineRunRow } from '../orchestration/pipeline-run-db'
import { createLocalCheckpointBackend, type PipelineCheckpointBackend } from './pipeline-checkpoint'
import { createSshCheckpointBackend } from './pipeline-checkpoint-ssh-backend'
import { resolvePreflightExecutionHost } from './pipeline-instantiation-host'
import type { PreflightExecutionHost } from './pipeline-preflight-executable-presence'

export type PipelineDriverRunContext = {
  dispatchWorktreeId: string
  isFolderMode: boolean
  host: PreflightExecutionHost
  worktreePath?: string
  checkpointBackend?: PipelineCheckpointBackend
}

export async function resolvePipelineDriverRunContext(
  runtime: OrcaRuntimeService,
  run: PipelineRunRow
): Promise<PipelineDriverRunContext> {
  const dispatchWorktreeId = run.run_worktree_id ?? run.workspace_id
  if (!dispatchWorktreeId) {
    throw new Error('Pipeline run has no dispatch worktree: the originating workspace is gone.')
  }
  const isFolderMode = run.run_worktree_id === null

  const worktree = await runtime.showManagedWorktree(`id:${dispatchWorktreeId}`)
  const repo = await runtime.showRepo(worktree.repoId)
  const host = resolvePreflightExecutionHost(runtime, repo, worktree.id)

  if (isFolderMode) {
    return { dispatchWorktreeId, isFolderMode, host }
  }

  const checkpointBackend = repo.connectionId
    ? createSshCheckpointBackend(requireSshGitProvider(repo.connectionId))
    : createLocalCheckpointBackend({ wslDistro: host.wslDistro })

  return {
    dispatchWorktreeId,
    isFolderMode,
    host,
    worktreePath: worktree.git.path,
    checkpointBackend
  }
}
