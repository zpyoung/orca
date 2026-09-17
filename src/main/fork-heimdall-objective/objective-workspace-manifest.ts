import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, readlink, readdir } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { MAX_FILE_RANGE_READ_BYTES } from '../../shared/file-range-read'
import type { IFilesystemProvider } from '../providers/types'
import { resolveLeasePathFlavor } from '../fork-heimdall/lease-host-filesystem'
import { runtimeFileRouteForTarget } from '../runtime/runtime-file-command-target'
import { objectiveGitCommandForTarget, type ObjectiveWorkspaceTarget } from './content-identity'
import { computeGitWorktreeContentDigest } from './git-worktree-content-digest'
import { gitPathModeEvidence, type GitPathModeEvidence } from './git-worktree-mode-evidence'
import {
  objectiveWorkspaceManifestDigest,
  type ObjectiveWorkspaceManifestEntry
} from './objective-workspace-manifest-digest'

const HASH_CONCURRENCY = 8

export type { ObjectiveWorkspaceManifestEntry }
export { objectiveWorkspaceManifestDigest }

type FileCandidate = {
  absolutePath: string
  path: string
  size: number
  mtimeMs: number
  type: 'file' | 'symlink'
}

type ObservedStat = {
  type: string
  size: number
  mtime: number
  mtimeMs?: number
}

function sha256(parts: readonly (string | Buffer)[]): string {
  const hash = createHash('sha256')
  for (const part of parts) {
    hash.update(part)
  }
  return hash.digest('hex')
}

export function objectiveFilesystemProviderForTarget(
  target: ObjectiveWorkspaceTarget
): IFilesystemProvider | null {
  const route = runtimeFileRouteForTarget(target)
  if (route.kind === 'local') {
    if (target.fileProvider !== null) {
      throw new Error('Objective filesystem routes are ambiguous')
    }
    return null
  }
  if (!route.provider) {
    throw new Error('Objective SSH filesystem route is unavailable')
  }
  if (route.provider !== target.fileProvider) {
    throw new Error('Objective SSH filesystem route changed after target resolution')
  }
  return route.provider
}

function parseNulPaths(stdout: string): string[] {
  const fields = stdout.split('\0')
  if (fields.at(-1) === '') {
    fields.pop()
  }
  if (fields.some((path) => path.length === 0)) {
    throw new Error('Git returned an empty path')
  }
  return fields
}

function isExcludedGitPath(path: string, caseInsensitive: boolean): boolean {
  const root = path.split('/', 1)[0]
  const normalized = caseInsensitive ? root.toLowerCase() : root
  return normalized === '.git' || normalized === '.orca'
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  limit: number,
  map: (value: T) => Promise<R>
): Promise<R[]> {
  const results = Array.from({ length: values.length }) as R[]
  let nextIndex = 0
  const concurrency = Math.min(limit, values.length)
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++
        results[index] = await map(values[index]!)
      }
    })
  )
  return results
}

type GitCommand = (args: string[]) => Promise<{ stdout: string; stderr: string }>
type GitIndexIdentity = { gitlink: boolean }

function parseGitIndexIdentities(stdout: string): Map<string, GitIndexIdentity> {
  const identities = new Map<string, GitIndexIdentity>()
  for (const field of parseNulPaths(stdout)) {
    const separator = field.indexOf('\t')
    const header = separator === -1 ? '' : field.slice(0, separator)
    const path = separator === -1 ? '' : field.slice(separator + 1)
    const match = /^([0-7]{6}) [0-9a-f]{40,64} ([0-3])$/u.exec(header)
    if (!match || !path) {
      throw new Error('Git returned malformed index metadata')
    }
    const identity = identities.get(path) ?? { gitlink: false }
    identity.gitlink ||= match[1] === '160000'
    identities.set(path, identity)
  }
  return identities
}

async function gitPathFingerprint(
  runGit: GitCommand,
  path: string,
  indexIdentity: GitIndexIdentity | undefined,
  evidence: GitPathModeEvidence
): Promise<string> {
  if (indexIdentity?.gitlink) {
    const nestedRunGit: GitCommand = (args) => runGit(['-C', path, ...args])
    const [head, status] = await Promise.all([
      nestedRunGit(['rev-parse', '--verify', 'HEAD']).then((result) => result.stdout.trim()),
      nestedRunGit([
        'status',
        '--porcelain=v2',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=none'
      ]).then((result) => result.stdout)
    ])
    return sha256(['gitlink\0', head, '\0', status])
  }
  if (evidence.modeIdentity === 'symlink') {
    if (evidence.symlinkTarget === undefined) {
      throw new Error(`Git returned no symlink target evidence for ${path}`)
    }
    return sha256(['git-symlink\0', evidence.symlinkTarget])
  }
  const objectId = (await runGit(['hash-object', '--', path])).stdout.trim()
  if (!/^[0-9a-f]{40,64}$/u.test(objectId)) {
    throw new Error(`Git did not return an object hash for ${path}`)
  }
  return sha256(['git-file\0', evidence.modeIdentity, '\0', objectId])
}

async function gitManifest(target: ObjectiveWorkspaceTarget) {
  const gitTarget = target.gitTarget
  if (
    !gitTarget ||
    gitTarget.executionHostId !== target.executionHostId ||
    gitTarget.worktree.path !== target.workspacePath
  ) {
    throw new Error('Objective Git and filesystem authorities disagree')
  }
  const runGit = objectiveGitCommandForTarget(target)
  const [listed, deleted, staged] = await Promise.all([
    runGit(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--']),
    runGit(['ls-files', '--deleted', '-z', '--']),
    runGit(['ls-files', '--stage', '-z', '--'])
  ])
  const caseInsensitive =
    resolveLeasePathFlavor(target.executionHostId, target.workspacePath) === win32
  const deletedPaths = new Set(parseNulPaths(deleted.stdout))
  const indexByPath = parseGitIndexIdentities(staged.stdout)
  objectiveFilesystemProviderForTarget(target)
  const paths = [...new Set(parseNulPaths(listed.stdout))]
    .filter((path) => !deletedPaths.has(path) && !isExcludedGitPath(path, caseInsensitive))
    .sort()
  const modeEvidence = await gitPathModeEvidence(runGit, paths)
  return await mapConcurrent(
    paths.map((path, index) => ({ path, evidence: modeEvidence[index]! })),
    HASH_CONCURRENCY,
    async ({ path, evidence }) => {
      const indexIdentity = indexByPath.get(path)
      return {
        path,
        fingerprint: await gitPathFingerprint(runGit, path, indexIdentity, evidence)
      }
    }
  )
}

function validateChildName(name: string, windowsPaths: boolean): void {
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    (windowsPaths && name.includes('\\'))
  ) {
    throw new Error('Filesystem provider returned an invalid directory entry')
  }
}

function candidateFromStat(absolutePath: string, path: string, stat: ObservedStat): FileCandidate {
  if (stat.type !== 'file' && stat.type !== 'symlink') {
    throw new Error(`Unsupported workspace entry type for ${path}`)
  }
  const candidate: FileCandidate = {
    absolutePath,
    path,
    size: stat.size,
    mtimeMs: stat.mtimeMs ?? stat.mtime,
    type: stat.type
  }
  if (
    !Number.isSafeInteger(candidate.size) ||
    candidate.size < 0 ||
    !Number.isFinite(candidate.mtimeMs) ||
    candidate.mtimeMs < 0
  ) {
    throw new Error(`Filesystem provider returned invalid metadata for ${path}`)
  }
  return candidate
}

async function listFolderCandidates(
  target: ObjectiveWorkspaceTarget,
  provider: IFilesystemProvider | null
): Promise<FileCandidate[]> {
  const flavor = resolveLeasePathFlavor(target.executionHostId, target.workspacePath)
  const windowsPaths = flavor === win32
  const directories = [{ absolutePath: target.workspacePath, relativePath: '' }]
  const files: FileCandidate[] = []
  while (directories.length > 0) {
    const directory = directories.pop()!
    const children = provider
      ? await provider.readDir(directory.absolutePath)
      : await readdir(directory.absolutePath, { withFileTypes: true }).then((entries) =>
          entries.map((entry) => ({
            name: entry.name,
            isDirectory: entry.isDirectory(),
            isSymlink: entry.isSymbolicLink()
          }))
        )
    for (const child of children) {
      validateChildName(child.name, windowsPaths)
      const relativePath = directory.relativePath
        ? posix.join(directory.relativePath, child.name)
        : child.name
      if ((windowsPaths ? relativePath.toLowerCase() : relativePath) === '.orca') {
        continue
      }
      if (provider && child.isSymlink && !provider.lstat) {
        throw new Error(`Remote symlink identity is unavailable for ${relativePath}`)
      }
      const absolutePath = flavor.join(directory.absolutePath, child.name)
      const rawStat: ObservedStat = provider
        ? await (provider.lstat?.(absolutePath) ?? provider.stat(absolutePath))
        : await lstat(absolutePath).then((stat) => ({
            type: stat.isDirectory()
              ? 'directory'
              : stat.isSymbolicLink()
                ? 'symlink'
                : stat.isFile()
                  ? 'file'
                  : 'other',
            size: stat.size,
            mtime: stat.mtimeMs,
            mtimeMs: stat.mtimeMs
          }))
      if (rawStat.type === 'directory') {
        if (child.isSymlink) {
          throw new Error(`Symlink followed during observation: ${relativePath}`)
        }
        directories.push({ absolutePath, relativePath })
      } else {
        files.push(candidateFromStat(absolutePath, relativePath, rawStat))
      }
    }
  }
  return files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}

function statStillMatches(candidate: FileCandidate, stat: ObservedStat): boolean {
  return (
    stat.type === candidate.type &&
    stat.size === candidate.size &&
    (stat.mtimeMs ?? stat.mtime) === candidate.mtimeMs
  )
}

async function hashLocalCandidate(candidate: FileCandidate): Promise<string> {
  let fingerprint: string
  if (candidate.type === 'symlink') {
    fingerprint = sha256(['symlink\0', await readlink(candidate.absolutePath)])
  } else {
    const hash = createHash('sha256')
    let bytesRead = 0
    for await (const chunk of createReadStream(candidate.absolutePath)) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytesRead += bytes.byteLength
      hash.update(bytes)
    }
    if (bytesRead !== candidate.size) {
      throw new Error(`Workspace file changed while reading ${candidate.path}`)
    }
    fingerprint = sha256(['file\0', hash.digest()])
  }
  const after = await lstat(candidate.absolutePath)
  const afterStat: ObservedStat = {
    type: after.isSymbolicLink() ? 'symlink' : after.isFile() ? 'file' : 'other',
    size: after.size,
    mtime: after.mtimeMs,
    mtimeMs: after.mtimeMs
  }
  if (!statStillMatches(candidate, afterStat)) {
    throw new Error(`Workspace entry changed while reading ${candidate.path}`)
  }
  return fingerprint
}

async function hashRemoteCandidate(
  provider: IFilesystemProvider,
  candidate: FileCandidate,
  rangeReads: boolean
): Promise<string> {
  let fingerprint: string
  if (candidate.type === 'symlink') {
    fingerprint = sha256([
      'symlink-metadata\0',
      String(candidate.size),
      '\0',
      String(candidate.mtimeMs)
    ])
  } else {
    const hash = createHash('sha256')
    let bytesRead = 0
    if (rangeReads && provider.readFileRange) {
      while (bytesRead < candidate.size) {
        const length = Math.min(MAX_FILE_RANGE_READ_BYTES, candidate.size - bytesRead)
        const window = await provider.readFileRange(candidate.absolutePath, bytesRead, length)
        if (
          window.bytesRead <= 0 ||
          window.bytesRead > length ||
          window.bytesRead !== window.bytes.byteLength
        ) {
          throw new Error(`Remote workspace file changed while reading ${candidate.path}`)
        }
        bytesRead += window.bytesRead
        hash.update(window.bytes)
      }
    } else {
      const read = await provider.readFile(candidate.absolutePath)
      const bytes = read.isBinary
        ? Buffer.from(read.content, 'base64')
        : Buffer.from(read.content, 'utf8')
      bytesRead = bytes.byteLength
      hash.update(bytes)
    }
    if (bytesRead !== candidate.size) {
      throw new Error(`Remote workspace file changed while reading ${candidate.path}`)
    }
    fingerprint = sha256(['file\0', hash.digest()])
  }
  const after = await (provider.lstat?.(candidate.absolutePath) ??
    provider.stat(candidate.absolutePath))
  if (!statStillMatches(candidate, after)) {
    throw new Error(`Remote workspace entry changed while reading ${candidate.path}`)
  }
  return fingerprint
}

async function folderManifest(target: ObjectiveWorkspaceTarget) {
  const provider = objectiveFilesystemProviderForTarget(target)
  const candidates = await listFolderCandidates(target, provider)
  const rangeReads = Boolean(
    provider?.readFileRange &&
    provider.supportsFileRangeRead &&
    (await provider.supportsFileRangeRead())
  )
  return await mapConcurrent(candidates, provider ? 2 : HASH_CONCURRENCY, async (candidate) => ({
    path: candidate.path,
    fingerprint: provider
      ? await hashRemoteCandidate(provider, candidate, rangeReads)
      : await hashLocalCandidate(candidate)
  }))
}

export async function observeObjectiveWorkspaceManifest(
  target: ObjectiveWorkspaceTarget
): Promise<ObjectiveWorkspaceManifestEntry[]> {
  objectiveFilesystemProviderForTarget(target)
  return target.kind === 'git' ? await gitManifest(target) : await folderManifest(target)
}

export async function computeObjectiveWorktreeContentDigest(
  target: ObjectiveWorkspaceTarget
): Promise<string> {
  return target.kind === 'git'
    ? await computeGitWorktreeContentDigest(target)
    : objectiveWorkspaceManifestDigest(await observeObjectiveWorkspaceManifest(target))
}
