import { posix } from 'node:path'
import {
  computeGitRepositoryIdentity,
  isObjectiveMetadataPath,
  mapConcurrent,
  type ObjectiveGitCommand,
  type ObjectiveWorkspaceTarget
} from './content-identity'

const TREE_PATH_BATCH_SIZE = 200
const TREE_LISTING_CONCURRENCY = 4

export type TreeEntryFingerprintRequest = {
  target: ObjectiveWorkspaceTarget
  runGit: ObjectiveGitCommand
  treeOid: string
  repositoryPrefix: string
  caseInsensitivePaths: boolean
  gitlink: GitlinkFingerprint
}

/** Resolves a `160000` entry; the two callers need different answers, so neither may assume one. */
export type GitlinkFingerprint = (path: string, commitOid: string) => Promise<string>

// A baseline's before-side is resolved long after capture, so only the tree's own record is stable.
export const recordedGitlinkFingerprint: GitlinkFingerprint = async (_path, commitOid) =>
  `submodule-commit\0${commitOid}`

// The digest compares a clean submodule against a dirty one, so both sides must read working state.
export function workingGitlinkFingerprint(
  target: ObjectiveWorkspaceTarget,
  runGit: ObjectiveGitCommand,
  repositoryPrefix: string,
  caseInsensitivePaths: boolean
): GitlinkFingerprint {
  return async (path, commitOid) => {
    const nestedRunGit: ObjectiveGitCommand = (args) => runGit(['-C', path, ...args])
    const nestedPrefix = repositoryPrefix ? posix.join(repositoryPrefix, path) : path
    try {
      return `submodule\0${await computeGitRepositoryIdentity(
        target,
        nestedRunGit,
        nestedPrefix,
        caseInsensitivePaths
      )}`
    } catch {
      return `submodule-uninitialized\0${commitOid}`
    }
  }
}

type TreeEntry = { mode: string; type: string; objectId: string; path: string }

const TREE_ENTRY = /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{40,64})\t([\s\S]+)$/u

function parseTreeEntries(stdout: string): TreeEntry[] {
  const fields = stdout.split('\0')
  if (fields.at(-1) === '') {
    fields.pop()
  }
  return fields.map((field) => {
    const match = TREE_ENTRY.exec(field)
    if (!match) {
      throw new Error('Git returned malformed tree metadata')
    }
    return { mode: match[1]!, type: match[2]!, objectId: match[3]!, path: match[4]! }
  })
}

// Mirrors fingerprintDirtyPath's tagged shape so a tree-side and a dirty-side value compare directly.
function blobFingerprint(mode: string, objectId: string): string {
  if (mode === '120000') {
    return `blob\0symlink\0mode-unavailable\0${objectId}`
  }
  return `blob\0file\0${mode === '100755' ? 'executable' : 'regular'}\0${objectId}`
}

async function collectEntries(
  request: TreeEntryFingerprintRequest,
  entries: readonly TreeEntry[],
  into: Map<string, string>
): Promise<void> {
  for (const entry of entries) {
    if (
      entry.type === 'tree' ||
      isObjectiveMetadataPath(entry.path, request.caseInsensitivePaths)
    ) {
      continue
    }
    into.set(
      entry.path,
      entry.type === 'commit'
        ? await request.gitlink(entry.path, entry.objectId)
        : blobFingerprint(entry.mode, entry.objectId)
    )
  }
}

/**
 * Fingerprints exactly the named paths as the given tree records them. Paths absent from the tree are
 * omitted, which callers read as the same `deleted` sentinel a dirty entry uses.
 */
export async function resolveTreeEntryFingerprints(
  request: TreeEntryFingerprintRequest,
  paths: readonly string[]
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>()
  for (let index = 0; index < paths.length; index += TREE_PATH_BATCH_SIZE) {
    const batch = paths.slice(index, index + TREE_PATH_BATCH_SIZE)
    const { stdout } = await request.runGit([
      '--literal-pathspecs',
      'ls-tree',
      '-z',
      request.treeOid,
      '--',
      ...batch
    ])
    await collectEntries(request, parseTreeEntries(stdout), resolved)
  }
  return resolved
}

/**
 * Fingerprints every entry the tree records, one bounded listing per top-level entry so no single
 * Git invocation has to buffer the whole tree.
 */
export async function listAllTreeEntryFingerprints(
  request: TreeEntryFingerprintRequest
): Promise<Map<string, string>> {
  const { stdout } = await request.runGit(['--literal-pathspecs', 'ls-tree', '-z', request.treeOid])
  const topLevel = parseTreeEntries(stdout)
  const listed = new Map<string, string>()
  await collectEntries(request, topLevel, listed)

  const subtrees = topLevel.filter(
    (entry) =>
      entry.type === 'tree' && !isObjectiveMetadataPath(entry.path, request.caseInsensitivePaths)
  )
  const nested = await mapConcurrent(subtrees, TREE_LISTING_CONCURRENCY, async (entry) =>
    parseTreeEntries(
      (
        await request.runGit([
          '--literal-pathspecs',
          'ls-tree',
          '-r',
          '-z',
          request.treeOid,
          '--',
          entry.path
        ])
      ).stdout
    )
  )
  for (const entries of nested) {
    await collectEntries(request, entries, listed)
  }
  return listed
}
