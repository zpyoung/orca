/** Checkpoint restore: restores branch HEAD, index, worktree content, and ignored-file handling to the checkpoint. */

import {
  clearSnapshotTypeObstructions,
  removeSnapshotDeletions
} from './pipeline-checkpoint-restore-obstructions'
import {
  runCheckpointGit,
  withTemporaryIndex,
  type CheckpointGitTarget
} from './pipeline-checkpoint-git'

export type CheckpointRestoreArgs = {
  head: string
  snapshot: string
}

export async function restoreCheckpoint(
  target: CheckpointGitTarget,
  args: CheckpointRestoreArgs
): Promise<void> {
  // why: submodule.recurse=true would otherwise hard-reset submodule working trees too — superproject-only (L9)
  await runCheckpointGit(target, ['reset', '--hard', '--no-recurse-submodules', args.head])
  // -ff: a plain -f leaves untracked nested git repos in place, but restore must remove that residue too.
  await runCheckpointGit(target, ['clean', '-ffd'])

  await removeSnapshotDeletions(target, args.head, args.snapshot)
  await clearSnapshotTypeObstructions(target, args.snapshot)

  await withTemporaryIndex(target, async (env) => {
    await runCheckpointGit(target, ['read-tree', '--no-recurse-submodules', args.snapshot], env)
    await runCheckpointGit(target, ['checkout-index', '-a', '-f'], env)
  })
}
