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
 * containment under `authorityRoot`, a before/after dev+ino recheck across the read, and a byte
 * cap enforced both before and after the read.
 */
export async function readHardenedReportBytes(params: {
  executionHostId: ExecutionHostId
  reportPath: string
  authorityRoot: string
  maxBytes: number
}): Promise<HardenedReportBytes | HardenedReportReadFailure> {
  const { executionHostId, reportPath, authorityRoot, maxBytes } = params
  return readHardenedLocalReportBytes(executionHostId, reportPath, authorityRoot, maxBytes)
}
