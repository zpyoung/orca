import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, readlink, readdir } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { MAX_FILE_RANGE_READ_BYTES } from '../../shared/file-range-read'
import { resolveWorktreeHostPath } from '../../shared/git-metadata-path'
import type { IFilesystemProvider } from '../providers/types'
import { resolveLeasePathFlavor } from '../fork-heimdall/lease-host-filesystem'
import { localGitOptionsForTarget } from '../runtime/runtime-git-command-target'
import { runtimeFileRouteForTarget } from '../runtime/runtime-file-command-target'
import { objectiveGitCommandForTarget, type ObjectiveWorkspaceTarget } from './content-identity'

const HASH_CONCURRENCY = 8

export type ObjectiveWorkspaceManifestEntry = { path: string; fingerprint: string }

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
type GitIndexIdentity = { modes: string[]; records: string[]; gitlink: boolean }

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
    const identity = identities.get(path) ?? { modes: [], records: [], gitlink: false }
    identity.modes.push(match[1])
    identity.records.push(header)
    identity.gitlink ||= match[1] === '160000'
    identities.set(path, identity)
  }
  return identities
}

function parseGitWorkingModes(stdout: string): Map<string, string> {
  const fields = parseNulPaths(stdout)
  const modes = new Map<string, string>()
  for (let index = 0; index < fields.length; index += 2) {
    const header = fields[index] ?? ''
    const path = fields[index + 1] ?? ''
    const match = /^:[0-7]{6} ([0-7]{6}) [0-9a-f]{40,64} [0-9a-f]{40,64} [A-Z]+$/u.exec(header)
    if (!match || !path) {
      throw new Error('Git returned malformed working-tree metadata')
    }
    modes.set(path, match[1])
  }
  return modes
}

async function untrackedGitPathIdentity(
  target: ObjectiveWorkspaceTarget,
  provider: IFilesystemProvider | null,
  path: string
): Promise<string> {
  if (provider) {
    if (!provider.lstat) {
      throw new Error('Remote untracked path identity requires lstat capability')
    }
    const stat = await provider.lstat(
      resolveLeasePathFlavor(target.executionHostId, target.workspacePath).join(
        target.workspacePath,
        ...path.split('/')
      )
    )
    if (stat.type !== 'file' && stat.type !== 'symlink') {
      throw new Error(`Unsupported untracked Git path type for ${path}`)
    }
    return `untracked:${stat.type}`
  }
  const gitTarget = target.gitTarget!
  const root =
    resolveWorktreeHostPath(target.workspacePath, localGitOptionsForTarget(gitTarget)) ??
    target.workspacePath
  const stat = await lstat(
    resolveLeasePathFlavor(target.executionHostId, root).join(root, ...path.split('/'))
  )
  if (stat.isSymbolicLink()) {
    return 'untracked:symlink'
  }
  if (!stat.isFile()) {
    throw new Error(`Unsupported untracked Git path type for ${path}`)
  }
  return `untracked:file:${(stat.mode & 0o111) === 0 ? 'regular' : 'executable'}`
}

async function gitPathFingerprint(
  runGit: GitCommand,
  path: string,
  indexIdentity: GitIndexIdentity | undefined,
  modeIdentity: string
): Promise<string> {
  if (indexIdentity?.gitlink) {
    const status = (
      await runGit([
        'status',
        '--porcelain=v2',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=none',
        '--',
        path
      ])
    ).stdout
    return sha256(['gitlink\0', ...indexIdentity.records.sort(), '\0', status])
  }
  const objectId = (await runGit(['hash-object', '--', path])).stdout.trim()
  if (!/^[0-9a-f]{40,64}$/u.test(objectId)) {
    throw new Error(`Git did not return an object hash for ${path}`)
  }
  return sha256(['git-file\0', modeIdentity, '\0', objectId])
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
  const [listed, deleted, staged, working] = await Promise.all([
    runGit(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--']),
    runGit(['ls-files', '--deleted', '-z', '--']),
    runGit(['ls-files', '--stage', '-z', '--']),
    runGit(['diff-files', '--raw', '--no-abbrev', '-z', '--'])
  ])
  const caseInsensitive =
    resolveLeasePathFlavor(target.executionHostId, target.workspacePath) === win32
  const deletedPaths = new Set(parseNulPaths(deleted.stdout))
  const indexByPath = parseGitIndexIdentities(staged.stdout)
  const workingModeByPath = parseGitWorkingModes(working.stdout)
  const fileProvider = objectiveFilesystemProviderForTarget(target)
  const paths = [...new Set(parseNulPaths(listed.stdout))]
    .filter((path) => !deletedPaths.has(path) && !isExcludedGitPath(path, caseInsensitive))
    .sort()
  return await mapConcurrent(paths, HASH_CONCURRENCY, async (path) => {
    const indexIdentity = indexByPath.get(path)
    const modeIdentity =
      workingModeByPath.get(path) ??
      (indexIdentity
        ? indexIdentity.modes.sort().join(',')
        : await untrackedGitPathIdentity(target, fileProvider, path))
    return {
      path,
      fingerprint: await gitPathFingerprint(runGit, path, indexIdentity, modeIdentity)
    }
  })
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
