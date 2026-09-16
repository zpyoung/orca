import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { chmod, lstat, mkdir, open, realpath } from 'node:fs/promises'
import type { ZodIssue } from 'zod'
import {
  IntegratorReportSchema,
  ImplementerReportSchema,
  PlannerReportSchema,
  ReviewerReportSchema,
  type IntegratorReport,
  type ImplementerReport,
  type PlannerReport,
  type ReviewerReport
} from '../../shared/fork-heimdall-objective/plan-schema'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../shared/cross-platform-path'
import { isBinaryBuffer } from '../../shared/binary-buffer'
import { resolveGitMetadataPath } from '../../shared/git-metadata-path'
import {
  NodeFileReadTooLargeError,
  readNodeFileHandleWithinLimit
} from '../../shared/node-bounded-file-reader'
import type { FileStat, IFilesystemProvider } from '../providers/types'
import { localGitOptionsForTarget } from '../runtime/runtime-git-command-target'
import { FileReadCapExceededError } from '../ssh/ssh-filesystem-stream-reader'
import { resolveLeasePathFlavor } from '../fork-heimdall/lease-host-filesystem'
import { objectiveGitCommandForTarget, type ObjectiveWorkspaceTarget } from './content-identity'

export const MAX_OBJECTIVE_REPORT_BYTES = 256 * 1024
const MAX_REPORT_SCHEMA_ISSUES = 5
const MAX_REPORT_SCHEMA_ISSUE_MESSAGE_CHARS = 512
const MAX_REPORT_SCHEMA_DETAIL_CHARS = 2_048

export type ObjectiveReportRole = 'planner' | 'implementer' | 'reviewer' | 'integrator'
export type ObjectiveRoleReport =
  | PlannerReport
  | ImplementerReport
  | ReviewerReport
  | IntegratorReport

type ObjectiveReportByRole = {
  planner: PlannerReport
  implementer: ImplementerReport
  reviewer: ReviewerReport
  integrator: IntegratorReport
}

export type ObjectiveReportReadFailureReason =
  | 'path-mismatch'
  | 'missing'
  | 'oversize'
  | 'binary'
  | 'malformed'
  | 'role-mismatch'
  | 'task-mismatch'

type ObjectiveReportReadFailure = {
  ok: false
  reason: ObjectiveReportReadFailureReason
  detail?: string
}

type ObjectiveReportReadSuccess<R extends ObjectiveReportRole> = R extends ObjectiveReportRole
  ? {
      ok: true
      role: R
      path: string
      report: ObjectiveReportByRole[R]
      reportDigest: string
    }
  : never

export type ObjectiveRoleReportReadResult<R extends ObjectiveReportRole = ObjectiveReportRole> =
  | ObjectiveReportReadSuccess<R>
  | ObjectiveReportReadFailure

export type ObjectiveRoleReportReadRequest<R extends ObjectiveReportRole = ObjectiveReportRole> = {
  target: ObjectiveWorkspaceTarget
  attemptFingerprint: string
  mailboxReportPath: string | null | undefined
  role: R
  taskKey?: string
}

function fingerprintFileName(attemptFingerprint: string): string {
  return `${createHash('sha256').update(attemptFingerprint).digest('hex')}.json`
}

type ObjectiveReportLocation = { authorityRoot: string; directory: string }

async function resolveObjectiveReportLocation(
  target: ObjectiveWorkspaceTarget
): Promise<ObjectiveReportLocation> {
  if (target.kind === 'folder') {
    if (target.fileProvider === null && target.executionHostId !== 'local') {
      throw new Error('Remote objective target has no filesystem provider')
    }
    const pathFlavor = resolveLeasePathFlavor(target.executionHostId, target.workspacePath)
    return {
      authorityRoot: target.workspacePath,
      directory: pathFlavor.join(target.workspacePath, '.orca', 'heimdall', 'objective', 'reports')
    }
  }

  const gitTarget = target.gitTarget
  if (!gitTarget) {
    throw new Error('Git objective target has no runtime Git target')
  }
  const rawGitDirectory = (
    await objectiveGitCommandForTarget(target)(['rev-parse', '--absolute-git-dir'])
  ).stdout.replace(/\r?\n$/u, '')
  if (!rawGitDirectory) {
    throw new Error('Git did not return an absolute git directory')
  }
  const gitDirectory =
    target.fileProvider === null
      ? resolveGitMetadataPath(
          target.workspacePath,
          rawGitDirectory,
          localGitOptionsForTarget(gitTarget)
        )
      : rawGitDirectory
  if (!gitDirectory) {
    throw new Error('Git returned an unusable git directory')
  }
  const pathFlavor = resolveLeasePathFlavor(target.executionHostId, gitDirectory)
  return {
    authorityRoot: gitDirectory,
    directory: pathFlavor.join(gitDirectory, 'orca-heimdall', 'objective', 'reports')
  }
}

function reportPathForLocation(
  target: ObjectiveWorkspaceTarget,
  location: ObjectiveReportLocation,
  attemptFingerprint: string
): string {
  const pathFlavor = resolveLeasePathFlavor(target.executionHostId, location.directory)
  return pathFlavor.join(location.directory, fingerprintFileName(attemptFingerprint))
}

export async function resolveExpectedObjectiveReportPath(
  target: ObjectiveWorkspaceTarget,
  attemptFingerprint: string
): Promise<string> {
  const location = await resolveObjectiveReportLocation(target)
  return reportPathForLocation(target, location, attemptFingerprint)
}

export async function issueObjectiveReportPath(
  target: ObjectiveWorkspaceTarget,
  attemptFingerprint: string
): Promise<string> {
  const location = await resolveObjectiveReportLocation(target)
  if (target.fileProvider) {
    await target.fileProvider.createDir(location.directory)
  } else {
    if (target.executionHostId !== 'local') {
      throw new Error('Remote objective target has no filesystem provider')
    }
    await mkdir(location.directory, { recursive: true, mode: 0o700 })
    await chmod(location.directory, 0o700)
  }
  return reportPathForLocation(target, location, attemptFingerprint)
}

export async function isIssuedObjectiveReportPath(args: {
  target: ObjectiveWorkspaceTarget
  attemptFingerprint: string
  mailboxReportPath: string | null | undefined
}): Promise<boolean> {
  if (typeof args.mailboxReportPath !== 'string') {
    return false
  }
  return (
    args.mailboxReportPath ===
    (await resolveExpectedObjectiveReportPath(args.target, args.attemptFingerprint))
  )
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

function formatIssuePath(path: readonly PropertyKey[]): string {
  let formatted = ''
  for (const segment of path) {
    if (typeof segment === 'number') {
      formatted += `[${segment}]`
      continue
    }
    const field = String(segment)
    formatted += formatted.length === 0 ? field : `.${field}`
  }
  return formatted || 'report'
}

function formatReportSchemaIssues(issues: readonly ZodIssue[]): string {
  const issueDetails = issues
    .slice(0, MAX_REPORT_SCHEMA_ISSUES)
    .map((issue) => {
      const message =
        issue.message.length <= MAX_REPORT_SCHEMA_ISSUE_MESSAGE_CHARS
          ? issue.message
          : `${issue.message.slice(0, MAX_REPORT_SCHEMA_ISSUE_MESSAGE_CHARS - 1)}…`
      return `${formatIssuePath(issue.path)}: ${message}`
    })
    .join('\n')
  const omittedIssueCount = Math.max(0, issues.length - MAX_REPORT_SCHEMA_ISSUES)
  if (omittedIssueCount > 0) {
    const omittedSummary = `+ ${omittedIssueCount} more issues`
    const availableIssueChars = MAX_REPORT_SCHEMA_DETAIL_CHARS - omittedSummary.length - 1
    const boundedIssueDetails =
      issueDetails.length <= availableIssueChars
        ? issueDetails
        : `${issueDetails.slice(0, availableIssueChars - 1)}…`
    return `${boundedIssueDetails}\n${omittedSummary}`
  }
  if (issueDetails.length <= MAX_REPORT_SCHEMA_DETAIL_CHARS) {
    return issueDetails
  }
  return `${issueDetails.slice(0, MAX_REPORT_SCHEMA_DETAIL_CHARS - 1)}…`
}

function parseReportForRole<R extends ObjectiveReportRole>(
  role: R,
  input: unknown
): { success: true; data: ObjectiveReportByRole[R] } | { success: false; detail: string } {
  const result =
    role === 'planner'
      ? PlannerReportSchema.safeParse(input)
      : role === 'implementer'
        ? ImplementerReportSchema.safeParse(input)
        : role === 'reviewer'
          ? ReviewerReportSchema.safeParse(input)
          : IntegratorReportSchema.safeParse(input)
  return result.success
    ? { success: true, data: result.data as ObjectiveReportByRole[R] }
    : { success: false, detail: formatReportSchemaIssues(result.error.issues) }
}

function matchesAnotherRole(input: unknown, expectedRole: ObjectiveReportRole): boolean {
  return (
    (expectedRole !== 'planner' && PlannerReportSchema.safeParse(input).success) ||
    (expectedRole !== 'implementer' && ImplementerReportSchema.safeParse(input).success) ||
    (expectedRole !== 'reviewer' && ReviewerReportSchema.safeParse(input).success) ||
    (expectedRole !== 'integrator' && IntegratorReportSchema.safeParse(input).success)
  )
}

const OPEN_NOFOLLOW = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
const OPEN_NONBLOCK = typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0
type ReportBytes = { buffer: Buffer; binary: boolean }

function pathsEqual(left: string, right: string): boolean {
  return normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right)
}

async function canonicalReportPath(
  target: ObjectiveWorkspaceTarget,
  reportPath: string,
  authorityRoot: string,
  resolveRealPath: (path: string) => Promise<string>
): Promise<string | null> {
  const pathFlavor = resolveLeasePathFlavor(target.executionHostId, reportPath)
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

async function readRemoteReportBytes(
  target: ObjectiveWorkspaceTarget,
  provider: IFilesystemProvider,
  reportPath: string,
  authorityRoot: string
): Promise<ReportBytes | ObjectiveReportReadFailure> {
  if (!provider.lstat || typeof provider.realpath !== 'function') {
    return { ok: false, reason: 'malformed' }
  }
  try {
    const canonicalPath = await canonicalReportPath(target, reportPath, authorityRoot, (path) =>
      provider.realpath(path)
    )
    if (!canonicalPath) {
      return { ok: false, reason: 'malformed' }
    }
    const before = await provider.lstat(canonicalPath)
    if (before.type !== 'file') {
      return { ok: false, reason: 'malformed' }
    }
    if (!Number.isSafeInteger(before.size) || before.size < 0) {
      return { ok: false, reason: 'malformed' }
    }
    if (before.size > MAX_OBJECTIVE_REPORT_BYTES) {
      return { ok: false, reason: 'oversize' }
    }
    const read = await provider.readFile(canonicalPath, {
      maxTextBytes: MAX_OBJECTIVE_REPORT_BYTES,
      maxBinaryBytes: MAX_OBJECTIVE_REPORT_BYTES
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
    if (buffer.byteLength > MAX_OBJECTIVE_REPORT_BYTES) {
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
    if (isMissingFileError(error)) {
      return { ok: false, reason: 'missing' }
    }
    throw error
  }
}

async function readLocalReportBytes(
  target: ObjectiveWorkspaceTarget,
  reportPath: string,
  authorityRoot: string
): Promise<ReportBytes | ObjectiveReportReadFailure> {
  try {
    const canonicalPath = await canonicalReportPath(target, reportPath, authorityRoot, realpath)
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
      const { buffer } = await readNodeFileHandleWithinLimit(handle, MAX_OBJECTIVE_REPORT_BYTES)
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

async function readReportBytes(
  target: ObjectiveWorkspaceTarget,
  reportPath: string,
  authorityRoot: string
): Promise<ReportBytes | ObjectiveReportReadFailure> {
  if (target.fileProvider) {
    return await readRemoteReportBytes(target, target.fileProvider, reportPath, authorityRoot)
  }
  if (target.executionHostId !== 'local') {
    throw new Error('Remote objective target has no filesystem provider')
  }
  return await readLocalReportBytes(target, reportPath, authorityRoot)
}

export async function readObjectiveRoleReport<R extends ObjectiveReportRole>(
  request: ObjectiveRoleReportReadRequest<R>
): Promise<ObjectiveRoleReportReadResult<R>> {
  const location = await resolveObjectiveReportLocation(request.target)
  const expectedPath = reportPathForLocation(request.target, location, request.attemptFingerprint)
  if (request.mailboxReportPath !== expectedPath) {
    return { ok: false, reason: 'path-mismatch' }
  }
  const read = await readReportBytes(request.target, expectedPath, location.authorityRoot)
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
  const parsed = parseReportForRole(request.role, input)
  if (!parsed.success) {
    const reason = matchesAnotherRole(input, request.role) ? 'role-mismatch' : 'malformed'
    return {
      ok: false,
      reason,
      ...(reason === 'malformed' ? { detail: parsed.detail } : {})
    }
  }
  if (
    request.role === 'implementer' &&
    request.taskKey !== undefined &&
    'taskKey' in parsed.data &&
    parsed.data.taskKey !== request.taskKey
  ) {
    return { ok: false, reason: 'task-mismatch' }
  }
  // The parser selection and the returned role share the same generic; TypeScript cannot
  // preserve that correlation while constructing a distributive conditional type.
  const success = {
    ok: true,
    role: request.role,
    path: expectedPath,
    report: parsed.data,
    reportDigest: createHash('sha256').update(read.buffer).digest('hex')
  } as ObjectiveReportReadSuccess<R>
  return success
}
