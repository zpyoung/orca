/** Clears on-disk paths and type collisions that would block checkout-index from materializing the snapshot tree (logic L9b items 3-4). */

import { join } from 'node:path'
import { getLocalWorktreePathAccess, removeLocalWorktreePath } from '../../local-worktree-filesystem'
import { runCheckpointGit, type CheckpointGitTarget } from './pipeline-checkpoint-git'

const SUBMODULE_MODE = '160000'
// git's well-known empty-tree object id — diffing against it lists every path in a tree.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

type DiffTreeEntry = { oldMode: string; newMode: string; status: string; path: string }

function parseDiffTreeRaw(output: string): DiffTreeEntry[] {
  const tokens = output.split('\0').filter((token) => token.length > 0)
  const entries: DiffTreeEntry[] = []
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const fields = tokens[i].slice(1).split(' ')
    entries.push({ oldMode: fields[0], newMode: fields[1], status: fields[4], path: tokens[i + 1] })
  }
  return entries
}

function isDirectoryStat(stat: unknown): boolean {
  const value =
    stat && typeof stat === 'object' ? (stat as { isDirectory?: () => boolean; type?: unknown }) : null
  return !!value && (value.isDirectory?.() === true || value.type === 'directory')
}

async function statKind(
  statPath: (path: string) => Promise<unknown>,
  path: string
): Promise<'directory' | 'file' | 'missing'> {
  try {
    return isDirectoryStat(await statPath(path)) ? 'directory' : 'file'
  } catch {
    return 'missing'
  }
}

function ancestorPaths(relativePath: string): string[] {
  const segments = relativePath.split('/')
  return segments.slice(1).map((_, index) => segments.slice(0, index + 1).join('/'))
}

/** Removes on-disk paths the snapshot tree no longer contains (L9b item 3). */
export async function removeSnapshotDeletions(
  target: CheckpointGitTarget,
  head: string,
  snapshot: string
): Promise<void> {
  const output = await runCheckpointGit(target, ['diff-tree', '-r', '-z', head, snapshot])
  for (const entry of parseDiffTreeRaw(output)) {
    if (entry.status === 'D' && entry.oldMode !== SUBMODULE_MODE) {
      await removeLocalWorktreePath(join(target.cwd, entry.path), { wslDistro: target.wslDistro })
    }
  }
}

/**
 * Removes any on-disk file/directory occupying a path (or an ancestor of a path) the snapshot tree
 * claims, so checkout-index can create the snapshot's file there — covers tracked type changes
 * (L9b item 3) and ignored obstructions (L9b item 4). Submodule paths are left untouched: checkout-index
 * never writes gitlink content, so clearing one would only risk the submodule's own working tree (L9).
 */
export async function clearSnapshotTypeObstructions(
  target: CheckpointGitTarget,
  snapshot: string
): Promise<void> {
  const output = await runCheckpointGit(target, ['diff-tree', '-r', '-z', EMPTY_TREE, snapshot])
  const { statPath } = getLocalWorktreePathAccess({ wslDistro: target.wslDistro })

  for (const entry of parseDiffTreeRaw(output)) {
    if (entry.newMode === SUBMODULE_MODE) {
      continue
    }
    for (const ancestor of ancestorPaths(entry.path)) {
      const ancestorPath = join(target.cwd, ancestor)
      if ((await statKind(statPath, ancestorPath)) === 'file') {
        await removeLocalWorktreePath(ancestorPath, { wslDistro: target.wslDistro })
      }
    }
    const leafPath = join(target.cwd, entry.path)
    if ((await statKind(statPath, leafPath)) === 'directory') {
      await removeLocalWorktreePath(leafPath, { wslDistro: target.wslDistro })
    }
  }
}
