/** Checkpoint capture: a GC-anchored snapshot of worktree content, without touching it (logic L9, L9a). */

import {
  checkpointRef,
  runCheckpointGit,
  withTemporaryIndex,
  type CheckpointGitTarget
} from './pipeline-checkpoint-git'

export type CheckpointCaptureArgs = {
  runId: string
  nodeId: string
  attempt: number
}

export type CheckpointCaptureResult = {
  head: string
  snapshot: string
  ref: string
}

export async function captureCheckpoint(
  target: CheckpointGitTarget,
  args: CheckpointCaptureArgs
): Promise<CheckpointCaptureResult> {
  const head = (await runCheckpointGit(target, ['rev-parse', 'HEAD'])).trim()
  const ref = checkpointRef(args.runId, args.nodeId, args.attempt)

  const status = await runCheckpointGit(target, [
    'status',
    '--porcelain',
    '--untracked-files=all'
  ])
  if (status.trim() === '') {
    await runCheckpointGit(target, ['update-ref', ref, head])
    return { head, snapshot: head, ref }
  }

  const snapshot = await withTemporaryIndex(target, async (env) => {
    // why: submodule.recurse=true would otherwise re-checkout submodule working trees during this read-only capture
    await runCheckpointGit(target, ['read-tree', '--no-recurse-submodules', 'HEAD'], env)
    await runCheckpointGit(target, ['add', '-A'], env)
    const tree = (await runCheckpointGit(target, ['write-tree'], env)).trim()
    const message = `orca pipeline checkpoint ${args.nodeId}-${args.attempt}`
    return (
      await runCheckpointGit(target, ['commit-tree', tree, '-p', head, '-m', message])
    ).trim()
  })

  await runCheckpointGit(target, ['update-ref', ref, snapshot])
  return { head, snapshot, ref }
}
