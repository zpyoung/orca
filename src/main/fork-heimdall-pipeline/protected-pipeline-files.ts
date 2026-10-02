import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, open, readlink, readdir } from 'node:fs/promises'
import { z } from 'zod'
import type { ExecutionHostId } from '../../shared/execution-host'
import {
  NodeFileReadTooLargeError,
  readNodeFileHandleWithinLimit
} from '../../shared/node-bounded-file-reader'
import type { FileStat, IFilesystemProvider } from '../providers/types'
import { FileReadCapExceededError } from '../ssh/ssh-filesystem-stream-reader'
import { requireRuntimeFileProvider } from '../runtime/runtime-file-command-target'
import {
  filesystemErrorCode,
  isMissingFilesystemError
} from '../fork-heimdall/filesystem-error-code'
import { resolveLeasePathFlavor } from '../fork-heimdall/lease-host-filesystem'

export const MAX_PROTECTED_PIPELINE_FILES = 200
export const MAX_PROTECTED_PIPELINE_FILE_BYTES = 1024 * 1024
export const PROTECTED_PIPELINE_OVER_CAP_PATH = '.orca/pipelines (over cap)'

export type ProtectedDigestEntry =
  | Readonly<{ path: string; kind: 'file'; sha256: string }>
  | Readonly<{ path: string; kind: 'symlink'; target: string }>

export type ProtectedDigest =
  | Readonly<{ status: 'ok'; entries: readonly ProtectedDigestEntry[] }>
  | Readonly<{ status: 'over-cap' }>

export class ProtectedDigestUnverifiableError extends Error {
  constructor(message = 'Protected pipeline files are unverifiable') {
    super(message)
    this.name = 'ProtectedDigestUnverifiableError'
  }
}

type ProtectedStat = {
  type: FileStat['type']
  size: number
  mtime: number
  mtimeMs?: number
  dev?: number
  ino?: number
}

type ProtectedFilesystem = {
  join(...parts: string[]): string
  lstat(path: string): Promise<ProtectedStat>
  readDir(path: string): Promise<string[]>
  readFile(path: string, maxBytes: number): Promise<Buffer>
  readlink(path: string): Promise<string>
}

class ProtectedDigestOverCapError extends Error {}

const ProtectedPathSchema = z
  .string()
  .refine(
    (path) =>
      path === '.orca' ||
      path === '.orca/pipelines' ||
      (path.startsWith('.orca/pipelines/') &&
        !path.split('/').some((segment) => segment === '.' || segment === '..'))
  )
const ProtectedDigestEntrySchema = z.discriminatedUnion('kind', [
  z
    .object({
      path: ProtectedPathSchema,
      kind: z.literal('file'),
      sha256: z.string().regex(/^[0-9a-f]{64}$/u)
    })
    .strict(),
  z.object({ path: ProtectedPathSchema, kind: z.literal('symlink'), target: z.string() }).strict()
])
const ProtectedDigestSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('over-cap') }).strict(),
  z.object({ status: z.literal('ok'), entries: z.array(ProtectedDigestEntrySchema) }).strict()
])

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function statType(stats: Stats): FileStat['type'] {
  if (stats.isSymbolicLink()) {
    return 'symlink'
  }
  if (stats.isDirectory()) {
    return 'directory'
  }
  return 'file'
}

function sameLocalFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function sameProtectedFile(left: ProtectedStat, right: ProtectedStat): boolean {
  if (
    typeof left.dev === 'number' &&
    typeof left.ino === 'number' &&
    typeof right.dev === 'number' &&
    typeof right.ino === 'number'
  ) {
    return left.dev === right.dev && left.ino === right.ino
  }
  return (
    left.type === right.type &&
    left.size === right.size &&
    (left.mtimeMs ?? left.mtime) === (right.mtimeMs ?? right.mtime)
  )
}

function localFilesystem(target: {
  executionHostId: ExecutionHostId
  workspacePath: string
}): ProtectedFilesystem {
  const pathFlavor = resolveLeasePathFlavor(target.executionHostId, target.workspacePath)
  return {
    join: (...parts) => pathFlavor.join(...parts),
    async lstat(path) {
      const stats = await lstat(path)
      return {
        type: statType(stats),
        size: stats.size,
        mtime: stats.mtimeMs,
        mtimeMs: stats.mtimeMs,
        dev: stats.dev,
        ino: stats.ino
      }
    },
    async readDir(path) {
      const before = await lstat(path)
      if (!before.isDirectory()) {
        throw new ProtectedDigestUnverifiableError('Protected directory changed before traversal')
      }
      const names = (await readdir(path)).sort(comparePaths)
      const after = await lstat(path)
      if (!after.isDirectory() || !sameLocalFile(before, after)) {
        throw new ProtectedDigestUnverifiableError('Protected directory changed during traversal')
      }
      return names
    },
    async readFile(path, maxBytes) {
      if (typeof constants.O_NOFOLLOW !== 'number') {
        throw new ProtectedDigestUnverifiableError(
          'Local filesystem cannot open protected files without following links'
        )
      }
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      )
      try {
        const opened = await handle.stat()
        const before = await lstat(path)
        if (!opened.isFile() || !before.isFile() || !sameLocalFile(opened, before)) {
          throw new ProtectedDigestUnverifiableError(
            'Protected file changed while it was being opened'
          )
        }
        if (opened.size > maxBytes) {
          throw new ProtectedDigestOverCapError()
        }
        const { buffer } = await readNodeFileHandleWithinLimit(handle, maxBytes)
        const [after, afterPath] = await Promise.all([handle.stat(), lstat(path)])
        if (
          !after.isFile() ||
          !afterPath.isFile() ||
          !sameLocalFile(opened, after) ||
          !sameLocalFile(opened, afterPath)
        ) {
          throw new ProtectedDigestUnverifiableError(
            'Protected file changed while it was being read'
          )
        }
        return buffer
      } catch (error) {
        if (error instanceof NodeFileReadTooLargeError) {
          throw new ProtectedDigestOverCapError()
        }
        throw error
      } finally {
        await handle.close()
      }
    },
    async readlink(path) {
      return readlink(path)
    }
  }
}

function remoteFilesystem(
  provider: IFilesystemProvider,
  target: { executionHostId: ExecutionHostId; workspacePath: string }
): ProtectedFilesystem {
  const lstatRemote = provider.lstat
  if (typeof lstatRemote !== 'function') {
    throw new ProtectedDigestUnverifiableError('Remote filesystem does not support lstat')
  }
  const pathFlavor = resolveLeasePathFlavor(target.executionHostId, target.workspacePath)
  return {
    join: (...parts) => pathFlavor.join(...parts),
    async lstat(path) {
      return lstatRemote.call(provider, path)
    },
    async readDir(path) {
      const before = await lstatRemote.call(provider, path)
      if (before.type !== 'directory') {
        throw new ProtectedDigestUnverifiableError('Protected directory changed before traversal')
      }
      const names = (await provider.readDir(path)).map((entry) => entry.name).sort(comparePaths)
      const after = await lstatRemote.call(provider, path)
      if (after.type !== 'directory' || !sameProtectedFile(before, after)) {
        throw new ProtectedDigestUnverifiableError('Protected directory changed during traversal')
      }
      return names
    },
    async readFile(path, maxBytes) {
      const before = await lstatRemote.call(provider, path)
      if (before.type !== 'file') {
        throw new ProtectedDigestUnverifiableError('Protected file is not a regular file')
      }
      if (before.size > maxBytes) {
        throw new ProtectedDigestOverCapError()
      }
      let result
      try {
        result = await provider.readFile(path, { maxTextBytes: maxBytes, maxBinaryBytes: maxBytes })
      } catch (error) {
        if (
          error instanceof FileReadCapExceededError ||
          (error instanceof Error && error.message === 'file_too_large')
        ) {
          throw new ProtectedDigestOverCapError()
        }
        throw error
      }
      const bytes = result.isBinary
        ? Buffer.from(result.content, 'base64')
        : Buffer.from(result.content, 'utf8')
      if (bytes.byteLength > maxBytes) {
        throw new ProtectedDigestOverCapError()
      }
      const after = await lstatRemote.call(provider, path)
      if (
        after.type !== 'file' ||
        !sameProtectedFile(before, after) ||
        bytes.byteLength !== after.size
      ) {
        throw new ProtectedDigestUnverifiableError('Protected file changed while it was being read')
      }
      return bytes
    },
    async readlink(path) {
      if (typeof provider.readlink !== 'function') {
        throw new ProtectedDigestUnverifiableError('Remote filesystem does not support readlink')
      }
      return provider.readlink(path)
    }
  }
}

async function captureEntries(
  target: { workspacePath: string },
  filesystem: ProtectedFilesystem
): Promise<ProtectedDigest> {
  const orcaPath = filesystem.join(target.workspacePath, '.orca')
  let orcaStat: ProtectedStat
  try {
    orcaStat = await filesystem.lstat(orcaPath)
  } catch (error) {
    if (isMissingFilesystemError(error)) {
      return { status: 'ok', entries: [] }
    }
    throw error
  }

  const entries: ProtectedDigestEntry[] = []
  let fileCount = 0
  const addFile = async (
    fullPath: string,
    relativePath: string,
    stat: ProtectedStat
  ): Promise<void> => {
    fileCount += 1
    if (fileCount > MAX_PROTECTED_PIPELINE_FILES || stat.size > MAX_PROTECTED_PIPELINE_FILE_BYTES) {
      throw new ProtectedDigestOverCapError()
    }
    const bytes = await filesystem.readFile(fullPath, MAX_PROTECTED_PIPELINE_FILE_BYTES)
    if (bytes.byteLength > MAX_PROTECTED_PIPELINE_FILE_BYTES) {
      throw new ProtectedDigestOverCapError()
    }
    entries.push({
      path: relativePath,
      kind: 'file',
      sha256: createHash('sha256').update(bytes).digest('hex')
    })
  }
  const addSymlink = async (fullPath: string, relativePath: string): Promise<void> => {
    fileCount += 1
    if (fileCount > MAX_PROTECTED_PIPELINE_FILES) {
      throw new ProtectedDigestOverCapError()
    }
    const targetValue = await filesystem.readlink(fullPath)
    if (Buffer.byteLength(targetValue, 'utf8') > MAX_PROTECTED_PIPELINE_FILE_BYTES) {
      throw new ProtectedDigestOverCapError()
    }
    entries.push({ path: relativePath, kind: 'symlink', target: targetValue })
  }
  const capturePath = async (
    fullPath: string,
    relativePath: string,
    stat: ProtectedStat
  ): Promise<void> => {
    if (stat.type === 'symlink') {
      await addSymlink(fullPath, relativePath)
    } else if (stat.type === 'file') {
      await addFile(fullPath, relativePath, stat)
    }
  }
  const captureDirectory = async (fullPath: string, relativeDirectory: string): Promise<void> => {
    const names = await filesystem.readDir(fullPath)
    const seenNames = new Set<string>()
    for (const name of names) {
      if (
        !name ||
        name === '.' ||
        name === '..' ||
        name.includes('/') ||
        name.includes('\\') ||
        seenNames.has(name)
      ) {
        throw new ProtectedDigestUnverifiableError(
          'Protected directory returned an invalid entry name'
        )
      }
      seenNames.add(name)
      const childPath = filesystem.join(fullPath, name)
      const childRelative = `${relativeDirectory}/${name}`
      const stat = await filesystem.lstat(childPath)
      await (stat.type === 'directory'
        ? captureDirectory(childPath, childRelative)
        : capturePath(childPath, childRelative, stat))
    }
  }

  if (orcaStat.type === 'symlink') {
    await addSymlink(orcaPath, '.orca')
    return { status: 'ok', entries }
  }
  if (orcaStat.type !== 'directory') {
    await capturePath(orcaPath, '.orca', orcaStat)
    return { status: 'ok', entries }
  }

  const pipelinesPath = filesystem.join(orcaPath, 'pipelines')
  let pipelinesStat: ProtectedStat
  try {
    pipelinesStat = await filesystem.lstat(pipelinesPath)
  } catch (error) {
    if (isMissingFilesystemError(error)) {
      const orcaAfter = await filesystem.lstat(orcaPath)
      if (orcaAfter.type !== 'directory' || !sameProtectedFile(orcaStat, orcaAfter)) {
        throw new ProtectedDigestUnverifiableError(
          'Protected metadata directory changed during traversal'
        )
      }
      return { status: 'ok', entries: [] }
    }
    throw error
  }
  const orcaAfter = await filesystem.lstat(orcaPath)
  if (orcaAfter.type !== 'directory' || !sameProtectedFile(orcaStat, orcaAfter)) {
    throw new ProtectedDigestUnverifiableError(
      'Protected metadata directory changed during traversal'
    )
  }
  await (pipelinesStat.type === 'directory'
    ? captureDirectory(pipelinesPath, '.orca/pipelines')
    : capturePath(pipelinesPath, '.orca/pipelines', pipelinesStat))
  entries.sort((left, right) => comparePaths(left.path, right.path))
  return { status: 'ok', entries }
}

/** Captures `.orca/pipelines/**` on the target execution host without following symlinks. */
export async function captureProtectedDigest(
  target: Readonly<{ executionHostId: ExecutionHostId; workspacePath: string }>
): Promise<ProtectedDigest> {
  try {
    const provider = requireRuntimeFileProvider(target)
    const filesystem = provider ? remoteFilesystem(provider, target) : localFilesystem(target)
    return await captureEntries(target, filesystem)
  } catch (error) {
    if (error instanceof ProtectedDigestOverCapError) {
      return { status: 'over-cap' }
    }
    if (error instanceof ProtectedDigestUnverifiableError) {
      throw error
    }
    if (
      error instanceof FileReadCapExceededError ||
      error instanceof NodeFileReadTooLargeError ||
      filesystemErrorCode(error) === 'EFBIG' ||
      (error instanceof Error && error.message === 'file_too_large')
    ) {
      return { status: 'over-cap' }
    }
    throw new ProtectedDigestUnverifiableError(
      error instanceof Error ? error.message : String(error)
    )
  }
}

/** Compares two captures; an over-cap capture is always a closed failure. */
export function compareProtectedDigest(
  before: ProtectedDigest,
  after: ProtectedDigest
): { changed: string[] } {
  if (before.status === 'over-cap' || after.status === 'over-cap') {
    return { changed: [PROTECTED_PIPELINE_OVER_CAP_PATH] }
  }
  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry]))
  const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry]))
  const paths = new Set([...beforeByPath.keys(), ...afterByPath.keys()])
  const changed: string[] = []
  for (const path of paths) {
    const previous = beforeByPath.get(path)
    const current = afterByPath.get(path)
    if (
      previous === undefined ||
      current === undefined ||
      previous.kind !== current.kind ||
      (previous.kind === 'file' && current.kind === 'file' && previous.sha256 !== current.sha256) ||
      (previous.kind === 'symlink' &&
        current.kind === 'symlink' &&
        previous.target !== current.target)
    ) {
      changed.push(path)
    }
  }
  changed.sort(comparePaths)
  return { changed }
}

/** Parses persisted digest JSON before it can be used as an attempt baseline. */
export function parseProtectedDigest(value: unknown): ProtectedDigest | null {
  const parsed = ProtectedDigestSchema.safeParse(value)
  if (!parsed.success) {
    return null
  }
  if (parsed.data.status === 'ok') {
    for (let index = 1; index < parsed.data.entries.length; index += 1) {
      const previous = parsed.data.entries[index - 1]
      const current = parsed.data.entries[index]
      if (previous && current && comparePaths(previous.path, current.path) >= 0) {
        return null
      }
    }
  }
  return parsed.data
}
