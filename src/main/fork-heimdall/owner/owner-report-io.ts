import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { chmod, lstat, mkdir, open, realpath } from 'node:fs/promises'
import type { z } from 'zod'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../../shared/cross-platform-path'
import { isBinaryBuffer } from '../../../shared/binary-buffer'
import {
  NodeFileReadTooLargeError,
  readNodeFileHandleWithinLimit
} from '../../../shared/node-bounded-file-reader'
import type { FileStat, IFilesystemProvider } from '../../providers/types'
import { FileReadCapExceededError } from '../../ssh/ssh-filesystem-stream-reader'
import { resolveLeasePathFlavor } from '../lease-host-filesystem'
import type { OwnerReportLocation } from './owner-report-location'

/** Generous relative to a worker report, since a rejection intervention can quote a long reason. */
export const MAX_OWNER_REPORT_BYTES = 64 * 1024

export type OwnerReportReadFailureReason =
  | 'path-mismatch'
  | 'missing'
  | 'oversize'
  | 'binary'
  | 'malformed'

export type OwnerReportReadResult<T> =
  | { ok: true; path: string; report: T }
  | { ok: false; reason: OwnerReportReadFailureReason; detail?: string }

const OPEN_NOFOLLOW = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
const OPEN_NONBLOCK = typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0

function reportFileName(wakeToken: string): string {
  return `${createHash('sha256').update(wakeToken).digest('hex')}.json`
}

/** The path the owner must write its intervention to for the given wake; deterministic, never trusted from the message. */
export function ownerReportPathForWake(location: OwnerReportLocation, wakeToken: string): string {
  const pathFlavor = resolveLeasePathFlavor(location.executionHostId, location.directory)
  return pathFlavor.join(location.directory, reportFileName(wakeToken))
}

export async function issueOwnerReportPath(
  location: OwnerReportLocation,
  wakeToken: string
): Promise<string> {
  if (location.fileProvider) {
    await location.fileProvider.createDir(location.directory)
  } else {
    await mkdir(location.directory, { recursive: true, mode: 0o700 })
    await chmod(location.directory, 0o700)
  }
  return ownerReportPathForWake(location, wakeToken)
}

function pathsEqual(left: string, right: string): boolean {
  return normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right)
}

async function canonicalReportPath(
  location: OwnerReportLocation,
  reportPath: string,
  resolveRealPath: (path: string) => Promise<string>
): Promise<string | null> {
  const pathFlavor = resolveLeasePathFlavor(location.executionHostId, reportPath)
  const [canonicalAuthority, canonicalParent, canonicalLeaf] = await Promise.all([
    resolveRealPath(location.authorityRoot),
    resolveRealPath(pathFlavor.dirname(reportPath)),
    resolveRealPath(reportPath)
  ])
  const canonicalExpected = pathFlavor.join(canonicalParent, pathFlavor.basename(reportPath))
  return isPathInsideOrEqual(canonicalAuthority, canonicalParent) &&
    pathsEqual(canonicalLeaf, canonicalExpected)
    ? canonicalExpected
    : null
}

function errorCode(error: unknown): string | number | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return undefined
  }
  const code = error.code
  return typeof code === 'string' || typeof code === 'number' ? code : undefined
}

function isMissingFileError(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 2
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
  return left.type === right.type && left.size === right.size && left.mtime === right.mtime
}

type ReportBytes = { buffer: Buffer; binary: boolean }
type ReportReadFailure = Extract<OwnerReportReadResult<never>, { ok: false }>

async function readRemoteReportBytes(
  provider: IFilesystemProvider,
  location: OwnerReportLocation,
  reportPath: string
): Promise<ReportBytes | ReportReadFailure> {
  if (!provider.lstat || typeof provider.realpath !== 'function') {
    return { ok: false, reason: 'malformed' }
  }
  try {
    const canonicalPath = await canonicalReportPath(location, reportPath, (path) =>
      provider.realpath(path)
    )
    if (!canonicalPath) {
      return { ok: false, reason: 'malformed' }
    }
    const before = await provider.lstat(canonicalPath)
    if (before.type !== 'file' || !Number.isSafeInteger(before.size) || before.size < 0) {
      return { ok: false, reason: 'malformed' }
    }
    if (before.size > MAX_OWNER_REPORT_BYTES) {
      return { ok: false, reason: 'oversize' }
    }
    const read = await provider.readFile(canonicalPath, {
      maxTextBytes: MAX_OWNER_REPORT_BYTES,
      maxBinaryBytes: MAX_OWNER_REPORT_BYTES
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
    if (buffer.byteLength > MAX_OWNER_REPORT_BYTES || buffer.byteLength !== after.size) {
      return {
        ok: false,
        reason: buffer.byteLength > MAX_OWNER_REPORT_BYTES ? 'oversize' : 'malformed'
      }
    }
    return { buffer, binary: read.isBinary || isBinaryBuffer(buffer) }
  } catch (error) {
    if (
      error instanceof FileReadCapExceededError ||
      (error instanceof Error && error.message === 'file_too_large')
    ) {
      return { ok: false, reason: 'oversize' }
    }
    if (isMissingFileError(error)) {
      return { ok: false, reason: 'missing' }
    }
    throw error
  }
}

async function readLocalReportBytes(
  location: OwnerReportLocation,
  reportPath: string
): Promise<ReportBytes | ReportReadFailure> {
  try {
    const canonicalPath = await canonicalReportPath(location, reportPath, realpath)
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
      const { buffer } = await readNodeFileHandleWithinLimit(handle, MAX_OWNER_REPORT_BYTES)
      return { buffer, binary: isBinaryBuffer(buffer) }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (error instanceof NodeFileReadTooLargeError) {
      return { ok: false, reason: 'oversize' }
    }
    if (isMissingFileError(error)) {
      return { ok: false, reason: 'missing' }
    }
    if (errorCode(error) === 'ELOOP' || errorCode(error) === 'ENXIO') {
      return { ok: false, reason: 'malformed' }
    }
    throw error
  }
}

/**
 * Reads and validates the owner's intervention report. Mirrors the objective worker report's own
 * hardening (`O_NOFOLLOW`, dev/ino recheck, canonical containment, size cap) so an owner turn is
 * held to the same "trust the file, not the claim" standard as any worker report.
 */
export async function readOwnerReport<T>(
  location: OwnerReportLocation,
  expectedPath: string,
  claimedPath: string | null | undefined,
  schema: z.ZodType<T>
): Promise<OwnerReportReadResult<T>> {
  if (claimedPath !== undefined && claimedPath !== null && claimedPath !== expectedPath) {
    return { ok: false, reason: 'path-mismatch' }
  }
  const read = location.fileProvider
    ? await readRemoteReportBytes(location.fileProvider, location, expectedPath)
    : await readLocalReportBytes(location, expectedPath)
  if ('ok' in read) {
    return read
  }
  if (read.binary) {
    return { ok: false, reason: 'binary' }
  }
  let input: unknown
  try {
    input = JSON.parse(read.buffer.toString('utf8'))
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, reason: 'malformed', detail: parsed.error.message.slice(0, 2_048) }
  }
  return { ok: true, path: expectedPath, report: parsed.data }
}
