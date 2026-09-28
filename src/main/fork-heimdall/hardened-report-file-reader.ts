import { constants, type Stats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import type { ExecutionHostId } from '../../shared/execution-host'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../shared/cross-platform-path'
import { isBinaryBuffer } from '../../shared/binary-buffer'
import {
  NodeFileReadTooLargeError,
  readNodeFileHandleWithinLimit
} from '../../shared/node-bounded-file-reader'
import type { FileStat, IFilesystemProvider } from '../providers/types'
import { FileReadCapExceededError } from '../ssh/ssh-filesystem-stream-reader'
import { resolveLeasePathFlavor } from './lease-host-filesystem'
import { filesystemErrorCode, isMissingFilesystemError } from './filesystem-error-code'

const OPEN_NOFOLLOW = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
const OPEN_NONBLOCK = typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0

export type HardenedReportBytes = { buffer: Buffer; binary: boolean }
export type HardenedReportReadFailure = { ok: false; reason: 'missing' | 'oversize' | 'malformed' }

function pathsEqual(left: string, right: string): boolean {
  return normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right)
}

async function canonicalReportPath(
  executionHostId: ExecutionHostId,
  reportPath: string,
  authorityRoot: string,
  resolveRealPath: (path: string) => Promise<string>
): Promise<string | null> {
  const pathFlavor = resolveLeasePathFlavor(executionHostId, reportPath)
  const [canonicalAuthority, canonicalParent, canonicalLeaf] = await Promise.all([
    resolveRealPath(authorityRoot),
    resolveRealPath(pathFlavor.dirname(reportPath)),
    resolveRealPath(reportPath)
  ])
  const canonicalExpected = pathFlavor.join(canonicalParent, pathFlavor.basename(reportPath))
  return isPathInsideOrEqual(canonicalAuthority, canonicalParent) &&
    pathsEqual(canonicalLeaf, canonicalExpected)
    ? canonicalExpected
    : null
}

function sameLocalFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function sameRemoteFile(left: FileStat, right: FileStat): boolean {
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

async function readHardenedRemoteReportBytes(
  executionHostId: ExecutionHostId,
  provider: IFilesystemProvider,
  reportPath: string,
  authorityRoot: string,
  maxBytes: number
): Promise<HardenedReportBytes | HardenedReportReadFailure> {
  if (!provider.lstat || typeof provider.realpath !== 'function') {
    return { ok: false, reason: 'malformed' }
  }
  try {
    const canonicalPath = await canonicalReportPath(
      executionHostId,
      reportPath,
      authorityRoot,
      (path) => provider.realpath(path)
    )
    if (!canonicalPath) {
      return { ok: false, reason: 'malformed' }
    }
    const before = await provider.lstat(canonicalPath)
    if (before.type !== 'file' || !Number.isSafeInteger(before.size) || before.size < 0) {
      return { ok: false, reason: 'malformed' }
    }
    if (before.size > maxBytes) {
      return { ok: false, reason: 'oversize' }
    }
    const read = await provider.readFile(canonicalPath, {
      maxTextBytes: maxBytes,
      maxBinaryBytes: maxBytes
    })
    const [after, currentCanonicalPath] = await Promise.all([
      provider.lstat(canonicalPath),
      provider.realpath(canonicalPath)
    ])
    if (
      after.type !== 'file' ||
      !sameRemoteFile(before, after) ||
      !pathsEqual(currentCanonicalPath, canonicalPath)
    ) {
      return { ok: false, reason: 'malformed' }
    }
    const buffer = read.isBinary
      ? Buffer.from(read.content, 'base64')
      : Buffer.from(read.content, 'utf8')
    if (buffer.byteLength > maxBytes) {
      return { ok: false, reason: 'oversize' }
    }
    if (buffer.byteLength !== after.size) {
      return { ok: false, reason: 'malformed' }
    }
    return { buffer, binary: read.isBinary || isBinaryBuffer(buffer) }
  } catch (error) {
    if (
      error instanceof FileReadCapExceededError ||
      (error instanceof Error && error.message === 'file_too_large')
    ) {
      return { ok: false, reason: 'oversize' }
    }
    if (isMissingFilesystemError(error)) {
      return { ok: false, reason: 'missing' }
    }
    throw error
  }
}

async function readHardenedLocalReportBytes(
  executionHostId: ExecutionHostId,
  reportPath: string,
  authorityRoot: string,
  maxBytes: number
): Promise<HardenedReportBytes | HardenedReportReadFailure> {
  try {
    const canonicalPath = await canonicalReportPath(
      executionHostId,
      reportPath,
      authorityRoot,
      realpath
    )
    if (!canonicalPath) {
      return { ok: false, reason: 'malformed' }
    }
    const handle = await open(canonicalPath, constants.O_RDONLY | OPEN_NOFOLLOW | OPEN_NONBLOCK)
    try {
      const [opened, leaf, currentCanonicalPath] = await Promise.all([
        handle.stat(),
        lstat(canonicalPath),
        realpath(canonicalPath)
      ])
      if (
        !opened.isFile() ||
        !leaf.isFile() ||
        !sameLocalFile(opened, leaf) ||
        !pathsEqual(currentCanonicalPath, canonicalPath)
      ) {
        return { ok: false, reason: 'malformed' }
      }
      const { buffer } = await readNodeFileHandleWithinLimit(handle, maxBytes)
      return { buffer, binary: isBinaryBuffer(buffer) }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (error instanceof NodeFileReadTooLargeError) {
      return { ok: false, reason: 'oversize' }
    }
    if (isMissingFilesystemError(error)) {
      return { ok: false, reason: 'missing' }
    }
    if (filesystemErrorCode(error) === 'ELOOP' || filesystemErrorCode(error) === 'ENXIO') {
      return { ok: false, reason: 'malformed' }
    }
    throw error
  }
}

/**
 * Reads a report file with the TOCTOU-safe hardening every report reader needs: canonical
 * containment under `authorityRoot`, a before/after dev+ino (or remote type+size+mtime) recheck
 * across the read, and a byte cap enforced both before and after the read.
 */
export async function readHardenedReportBytes(params: {
  executionHostId: ExecutionHostId
  fileProvider: IFilesystemProvider | null
  reportPath: string
  authorityRoot: string
  maxBytes: number
}): Promise<HardenedReportBytes | HardenedReportReadFailure> {
  const { executionHostId, fileProvider, reportPath, authorityRoot, maxBytes } = params
  return fileProvider
    ? readHardenedRemoteReportBytes(
        executionHostId,
        fileProvider,
        reportPath,
        authorityRoot,
        maxBytes
      )
    : readHardenedLocalReportBytes(executionHostId, reportPath, authorityRoot, maxBytes)
}
