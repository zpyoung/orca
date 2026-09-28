import { createHash } from 'node:crypto'
import { chmod, mkdir } from 'node:fs/promises'
import type { z } from 'zod'
import { resolveLeasePathFlavor } from '../lease-host-filesystem'
import { readHardenedReportBytes } from '../hardened-report-file-reader'
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
  const read = await readHardenedReportBytes({
    executionHostId: location.executionHostId,
    fileProvider: location.fileProvider,
    reportPath: expectedPath,
    authorityRoot: location.authorityRoot,
    maxBytes: MAX_OWNER_REPORT_BYTES
  })
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
