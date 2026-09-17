import { win32 } from 'node:path'
import { resolveLeasePathFlavor } from '../fork-heimdall/lease-host-filesystem'
import {
  isObjectiveMetadataPath,
  objectiveGitCommandForTarget,
  type GitWorkspaceObservation,
  type ObjectiveGitCommand,
  type ObjectiveWorkspaceTarget
} from './content-identity'
import {
  recordedGitlinkFingerprint,
  resolveTreeEntryFingerprints,
  type TreeEntryFingerprintRequest
} from './git-tree-entry-fingerprint'

const DELETED = 'deleted'

function dirtyByPath(observation: GitWorkspaceObservation): Map<string, string> {
  return new Map(observation.dirty.map((entry) => [entry.path, entry.fingerprint]))
}

async function committedCandidatePaths(
  runGit: ObjectiveGitCommand,
  before: GitWorkspaceObservation,
  after: GitWorkspaceObservation,
  caseInsensitivePaths: boolean
): Promise<string[]> {
  if (before.treeOid === 'unborn' || after.treeOid === 'unborn') {
    return []
  }
  if (before.treeOid === after.treeOid) {
    return []
  }
  const { stdout } = await runGit([
    'diff-tree',
    '-r',
    '-z',
    '--name-only',
    before.treeOid,
    after.treeOid
  ])
  const fields = stdout.split('\0')
  if (fields.at(-1) === '') {
    fields.pop()
  }
  return fields.filter((path) => path && !isObjectiveMetadataPath(path, caseInsensitivePaths))
}

/**
 * Reports the paths whose working-tree content differs between two observations of the same Git
 * workspace.
 *
 * A path counts as changed only when its *effective* content differs, where effective content is the
 * dirty fingerprint when that side had the path dirty and the tree's own record otherwise. Comparing
 * the committed trees alone is wrong in both directions: content that was dirty and is then committed
 * unmodified shows up in the tree diff without ever changing on disk, and content that is reverted to
 * HEAD changes on disk while leaving both trees identical.
 */
export async function computeGitWorkspaceChangedPaths(
  target: ObjectiveWorkspaceTarget,
  before: GitWorkspaceObservation,
  after: GitWorkspaceObservation
): Promise<string[]> {
  const runGit = objectiveGitCommandForTarget(target)
  const caseInsensitivePaths =
    resolveLeasePathFlavor(target.executionHostId, target.workspacePath) === win32
  const beforeDirty = dirtyByPath(before)
  const afterDirty = dirtyByPath(after)

  const candidates = new Set<string>([
    ...(await committedCandidatePaths(runGit, before, after, caseInsensitivePaths)),
    ...beforeDirty.keys(),
    ...afterDirty.keys()
  ])
  if (candidates.size === 0) {
    return []
  }

  const request = (treeOid: string): TreeEntryFingerprintRequest => ({
    target,
    runGit,
    treeOid,
    repositoryPrefix: '',
    caseInsensitivePaths,
    gitlink: recordedGitlinkFingerprint
  })
  const needBefore = [...candidates].filter((path) => !beforeDirty.has(path))
  const needAfter = [...candidates].filter((path) => !afterDirty.has(path))
  const [beforeTree, afterTree] = await Promise.all([
    before.treeOid === 'unborn'
      ? new Map<string, string>()
      : resolveTreeEntryFingerprints(request(before.treeOid), needBefore),
    after.treeOid === 'unborn'
      ? new Map<string, string>()
      : resolveTreeEntryFingerprints(request(after.treeOid), needAfter)
  ])

  const changed: string[] = []
  for (const path of candidates) {
    const left = beforeDirty.get(path) ?? beforeTree.get(path) ?? DELETED
    const right = afterDirty.get(path) ?? afterTree.get(path) ?? DELETED
    if (left !== right) {
      changed.push(path)
    }
  }
  return changed.sort()
}
