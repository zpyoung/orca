import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { objectivePathMatchesTerritory } from '../../shared/fork-heimdall-objective/plan-schema'
import type { IFilesystemProvider } from '../providers/types'
import { resolveLeasePathFlavor } from '../fork-heimdall/lease-host-filesystem'
import { observeGitWorkspaceState, type ObjectiveWorkspaceTarget } from './content-identity'
import { computeGitWorkspaceChangedPaths } from './git-workspace-changed-set'
import {
  GIT_BASELINE_VERSION,
  LEGACY_BASELINE_VERSION,
  parseBaseline,
  sameTarget,
  targetDescriptor,
  type WorkspaceBaseline
} from './objective-workspace-baseline-schema'
import {
  objectiveFilesystemProviderForTarget,
  observeObjectiveWorkspaceManifest,
  type ObjectiveWorkspaceManifestEntry as ManifestEntry
} from './objective-workspace-manifest'
import { resolveExpectedObjectiveReportPath } from './report-ingestion'

const MAX_BASELINE_BYTES = 64 * 1024 * 1024

type BaselineRead =
  | { state: 'ok'; baseline: WorkspaceBaseline }
  | { state: 'missing' | 'malformed' | 'unreadable' }
type BaselineLocation = { directory: string; path: string }

function errorCode(error: unknown): string | number | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return undefined
  }
  const code = error.code
  return typeof code === 'string' || typeof code === 'number' ? code : undefined
}

function isMissing(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 2
}

async function baselinePath(
  target: ObjectiveWorkspaceTarget,
  attemptFingerprint: string
): Promise<BaselineLocation> {
  const reportPath = await resolveExpectedObjectiveReportPath(target, attemptFingerprint)
  const flavor = resolveLeasePathFlavor(target.executionHostId, reportPath)
  const directory = flavor.join(flavor.dirname(reportPath), 'workspace-baselines')
  return { directory, path: flavor.join(directory, flavor.basename(reportPath)) }
}

async function readStoredBaseline(
  provider: IFilesystemProvider | null,
  path: string
): Promise<BaselineRead> {
  try {
    if (provider) {
      if (!provider.lstat) {
        return { state: 'unreadable' }
      }
      const stat = await provider.lstat(path)
      if (stat.type !== 'file' || !Number.isSafeInteger(stat.size) || stat.size < 0) {
        return { state: 'malformed' }
      }
      if (stat.size > MAX_BASELINE_BYTES) {
        return { state: 'malformed' }
      }
      const read = await provider.readFile(path, {
        maxTextBytes: MAX_BASELINE_BYTES,
        maxBinaryBytes: MAX_BASELINE_BYTES
      })
      if (read.isBinary || Buffer.byteLength(read.content, 'utf8') !== stat.size) {
        return { state: 'malformed' }
      }
      const parsed = parseBaseline(JSON.parse(read.content))
      return parsed ? { state: 'ok', baseline: parsed } : { state: 'malformed' }
    }
    const stat = await lstat(path)
    if (!stat.isFile() || stat.size > MAX_BASELINE_BYTES) {
      return { state: 'malformed' }
    }
    const bytes = await readFile(path)
    if (bytes.byteLength !== stat.size) {
      return { state: 'unreadable' }
    }
    const parsed = parseBaseline(JSON.parse(bytes.toString('utf8')))
    return parsed ? { state: 'ok', baseline: parsed } : { state: 'malformed' }
  } catch (error) {
    if (isMissing(error)) {
      return { state: 'missing' }
    }
    if (error instanceof SyntaxError) {
      return { state: 'malformed' }
    }
    return { state: 'unreadable' }
  }
}

async function writeBaseline(
  target: ObjectiveWorkspaceTarget,
  baseline: WorkspaceBaseline,
  directory: string,
  path: string
): Promise<void> {
  const provider = objectiveFilesystemProviderForTarget(target)
  const serialized = JSON.stringify(baseline)
  if (!provider) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    try {
      await writeFile(path, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      return
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw error
      }
    }
  } else {
    await provider.createDir(directory)
    const temporaryPath = `${path}.${randomUUID()}.tmp`
    await provider.writeFile(temporaryPath, serialized)
    try {
      await provider.renameNoClobber(temporaryPath, path)
      return
    } catch (error) {
      await provider.deletePath(temporaryPath).catch(() => undefined)
      const existing = await readStoredBaseline(provider, path)
      if (
        existing.state === 'ok' &&
        existing.baseline.attemptFingerprint === baseline.attemptFingerprint &&
        sameTarget(existing.baseline.target, baseline.target)
      ) {
        return
      }
      throw error
    }
  }
  const existing = await readStoredBaseline(provider, path)
  if (
    existing.state !== 'ok' ||
    existing.baseline.attemptFingerprint !== baseline.attemptFingerprint ||
    !sameTarget(existing.baseline.target, baseline.target)
  ) {
    throw new Error('Objective workspace baseline already exists but is unusable')
  }
}

export async function captureObjectiveWorkspaceBaseline(
  target: ObjectiveWorkspaceTarget,
  attemptFingerprint: string
): Promise<void> {
  const provider = objectiveFilesystemProviderForTarget(target)
  const location = await baselinePath(target, attemptFingerprint)
  const existing = await readStoredBaseline(provider, location.path)
  if (existing.state === 'ok') {
    if (
      existing.baseline.attemptFingerprint !== attemptFingerprint ||
      !sameTarget(existing.baseline.target, targetDescriptor(target))
    ) {
      throw new Error('Objective workspace baseline does not match its originating attempt')
    }
    return
  }
  if (existing.state !== 'missing') {
    throw new Error(`Objective workspace baseline is ${existing.state}`)
  }
  const baseline: WorkspaceBaseline =
    target.kind === 'git'
      ? {
          version: GIT_BASELINE_VERSION,
          attemptFingerprint,
          target: targetDescriptor(target),
          git: await observeGitWorkspaceState(target)
        }
      : {
          version: LEGACY_BASELINE_VERSION,
          attemptFingerprint,
          target: targetDescriptor(target),
          entries: await observeObjectiveWorkspaceManifest(target)
        }
  await writeBaseline(target, baseline, location.directory, location.path)
}

function changedPaths(before: readonly ManifestEntry[], after: readonly ManifestEntry[]): string[] {
  const beforeByPath = new Map(before.map((entry) => [entry.path, entry.fingerprint]))
  const afterByPath = new Map(after.map((entry) => [entry.path, entry.fingerprint]))
  const paths = new Set([...beforeByPath.keys(), ...afterByPath.keys()])
  return [...paths].filter((path) => beforeByPath.get(path) !== afterByPath.get(path)).sort()
}

export async function validateObjectiveWorkspaceChanges(args: {
  target: ObjectiveWorkspaceTarget
  attemptFingerprint: string
  reportedFiles: readonly string[]
  writeTerritory: readonly string[]
}): Promise<{ ok: true; changedPaths: string[] } | { ok: false; reason: string }> {
  let provider: IFilesystemProvider | null
  let location: BaselineLocation
  try {
    provider = objectiveFilesystemProviderForTarget(args.target)
    location = await baselinePath(args.target, args.attemptFingerprint)
  } catch {
    return { ok: false, reason: 'objective-workspace-route-unavailable' }
  }
  const stored = await readStoredBaseline(provider, location.path)
  if (stored.state !== 'ok') {
    return { ok: false, reason: `objective-workspace-baseline-${stored.state}` }
  }
  if (
    stored.baseline.attemptFingerprint !== args.attemptFingerprint ||
    !sameTarget(stored.baseline.target, targetDescriptor(args.target))
  ) {
    return { ok: false, reason: 'objective-workspace-baseline-mismatch' }
  }
  let observed: string[]
  try {
    observed =
      stored.baseline.version === GIT_BASELINE_VERSION
        ? await computeGitWorkspaceChangedPaths(
            args.target,
            stored.baseline.git,
            await observeGitWorkspaceState(args.target)
          )
        : changedPaths(
            stored.baseline.entries,
            await observeObjectiveWorkspaceManifest(args.target)
          )
  } catch {
    return { ok: false, reason: 'objective-workspace-observation-failed' }
  }
  const outside = observed.find((path) => !objectivePathMatchesTerritory(path, args.writeTerritory))
  if (outside) {
    return { ok: false, reason: `observed-change-outside-write-territory:${outside}` }
  }
  if (
    new Set(args.reportedFiles).size !== args.reportedFiles.length ||
    args.reportedFiles.some((path) => !objectivePathMatchesTerritory(path, args.writeTerritory))
  ) {
    return { ok: false, reason: 'reported-files-invalid' }
  }
  const reported = [...args.reportedFiles].sort()
  if (
    reported.length !== observed.length ||
    reported.some((path, index) => path !== observed[index])
  ) {
    return { ok: false, reason: 'reported-files-do-not-match-observed-changes' }
  }
  return { ok: true, changedPaths: observed }
}
