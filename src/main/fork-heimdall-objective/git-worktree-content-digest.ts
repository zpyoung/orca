import { win32 } from 'node:path'
import { resolveLeasePathFlavor } from '../fork-heimdall/lease-host-filesystem'
import {
  objectiveGitCommandForTarget,
  observeGitWorkspaceState,
  type ObjectiveWorkspaceTarget
} from './content-identity'
import {
  listAllTreeEntryFingerprints,
  workingGitlinkFingerprint
} from './git-tree-entry-fingerprint'
import {
  objectiveWorkspaceManifestDigest,
  type ObjectiveWorkspaceManifestEntry
} from './objective-workspace-manifest-digest'

const DELETED = 'deleted'

/**
 * Digests the working-tree content of a Git workspace.
 *
 * The committed entries are merged with the dirty ones before hashing rather than being folded in
 * alongside the tree id, because the landing path compares this value across a commit: content that
 * was dirty and is then committed unmodified has to digest identically on both sides, and any digest
 * that carries `HEAD^{tree}` cannot.
 */
export async function computeGitWorktreeContentDigest(
  target: ObjectiveWorkspaceTarget
): Promise<string> {
  const runGit = objectiveGitCommandForTarget(target)
  const caseInsensitivePaths =
    resolveLeasePathFlavor(target.executionHostId, target.workspacePath) === win32
  const observed = await observeGitWorkspaceState(target)
  const merged =
    observed.treeOid === 'unborn'
      ? new Map<string, string>()
      : await listAllTreeEntryFingerprints({
          target,
          runGit,
          treeOid: observed.treeOid,
          repositoryPrefix: '',
          caseInsensitivePaths,
          gitlink: workingGitlinkFingerprint(target, runGit, '', caseInsensitivePaths)
        })

  for (const entry of observed.dirty) {
    if (entry.fingerprint === DELETED) {
      merged.delete(entry.path)
      continue
    }
    merged.set(entry.path, entry.fingerprint)
  }

  const manifest: ObjectiveWorkspaceManifestEntry[] = [...merged]
    .map(([path, fingerprint]) => ({ path, fingerprint }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return objectiveWorkspaceManifestDigest(manifest)
}
