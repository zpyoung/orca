/** Low-level git plumbing shared by pipeline-checkpoint capture and restore (logic §4.6). */

import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitExecFileAsync } from '../../git/runner'
import { removeHostTree } from '../../host-tree-removal'
import { toLinuxPath } from '../../wsl'
import { addWslEnvKeys } from '../../wsl-env'

export type CheckpointGitRunner = (
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv
) => Promise<string>

export type CheckpointGitTarget = {
  cwd: string
  wslDistro?: string
  // relay backend supplies its own executor here; local/WSL omits it and gets the gitExecFileAsync default below
  run?: CheckpointGitRunner
}

export function checkpointRef(runId: string, nodeId: string, attempt: number): string {
  return `refs/orca/pipeline/${runId}/${nodeId}-${attempt}`
}

/** Runs one git subcommand against the worktree; never a shell, so args need no escaping. */
export async function runCheckpointGit(
  target: CheckpointGitTarget,
  args: string[],
  env?: NodeJS.ProcessEnv
): Promise<string> {
  if (target.run) {
    return target.run(args, target.cwd, env)
  }
  const { stdout } = await gitExecFileAsync(args, {
    cwd: target.cwd,
    wslDistro: target.wslDistro,
    ...(env ? { env } : {})
  })
  return stdout
}

/**
 * Runs `run` against a fresh index file outside the repo (GIT_INDEX_FILE), so the caller's own
 * index/HEAD/worktree stay untouched — the temp-index posture L9 requires for capture, reused by
 * restore's snapshot materialization step.
 */
export async function withTemporaryIndex<T>(
  target: CheckpointGitTarget,
  run: (env: NodeJS.ProcessEnv) => Promise<T>
): Promise<T> {
  const tmpIndexPath = join(tmpdir(), `orca-pipeline-checkpoint-${randomUUID()}.index`)
  const indexFileValue = target.wslDistro ? toLinuxPath(tmpIndexPath) : tmpIndexPath
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: indexFileValue }
  if (target.wslDistro) {
    addWslEnvKeys(env, ['GIT_INDEX_FILE'])
  }
  try {
    return await run(env)
  } finally {
    await removeHostTree(tmpIndexPath)
  }
}
