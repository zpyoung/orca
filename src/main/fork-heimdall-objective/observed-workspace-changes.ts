import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import { objectivePathMatchesTerritory } from '../../shared/fork-heimdall-objective/plan-schema'
import { resolveWorktreeHostPath } from '../../shared/git-metadata-path'
import { checkIgnoredPaths } from '../git/check-ignored-paths'
import { isENOENT } from '../ipc/filesystem-path-containment'
import type { IFilesystemProvider } from '../providers/types'
import {
  localGitOptionsForTarget,
  requireRuntimeGitProvider
} from '../runtime/runtime-git-command-target'
import { resolveLeasePathFlavor } from '../fork-heimdall/lease-host-filesystem'
import {
  mapConcurrent,
  observeGitWorkspaceState,
  type ObjectiveWorkspaceTarget
} from './content-identity'
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
const REPORTED_PATH_PROBE_CONCURRENCY = 8

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
  attemptFingerprint: string,
  sourceTarget: ObjectiveWorkspaceTarget = target
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
  if (target.kind !== sourceTarget.kind) {
    throw new Error('Objective workspace baseline source kind does not match its destination')
  }
  const baseline: WorkspaceBaseline =
    target.kind === 'git'
      ? {
          version: GIT_BASELINE_VERSION,
          attemptFingerprint,
          target: targetDescriptor(target),
          git: await observeGitWorkspaceState(sourceTarget)
        }
      : {
          version: LEGACY_BASELINE_VERSION,
          attemptFingerprint,
          target: targetDescriptor(target),
          entries: await observeObjectiveWorkspaceManifest(sourceTarget)
        }
  await writeBaseline(target, baseline, location.directory, location.path)
}

function changedPaths(before: readonly ManifestEntry[], after: readonly ManifestEntry[]): string[] {
  const beforeByPath = new Map(before.map((entry) => [entry.path, entry.fingerprint]))
  const afterByPath = new Map(after.map((entry) => [entry.path, entry.fingerprint]))
  const paths = new Set([...beforeByPath.keys(), ...afterByPath.keys()])
  return [...paths].filter((path) => beforeByPath.get(path) !== afterByPath.get(path)).sort()
}

async function ignoredReportedPaths(
  target: ObjectiveWorkspaceTarget,
  paths: readonly string[]
): Promise<Set<string>> {
  if (target.kind !== 'git' || paths.length === 0) {
    return new Set()
  }
  const gitTarget = target.gitTarget
  if (
    !gitTarget ||
    gitTarget.executionHostId !== target.executionHostId ||
    gitTarget.worktree.path !== target.workspacePath
  ) {
    throw new Error('Objective Git and filesystem authorities disagree')
  }
  const provider = requireRuntimeGitProvider(gitTarget)
  const ignored = provider
    ? await provider.checkIgnoredPaths(target.workspacePath, [...paths])
    : await checkIgnoredPaths(target.workspacePath, [...paths], {
        ...localGitOptionsForTarget(gitTarget),
        admissionTier: 'background'
      })
  const requested = new Set(paths)
  if (ignored.some((path) => !requested.has(path))) {
    throw new Error('Git returned an unrequested ignored path')
  }
  return new Set(ignored)
}

async function existingContainedPaths(
  target: ObjectiveWorkspaceTarget,
  paths: ReadonlySet<string>
): Promise<Set<string>> {
  if (paths.size === 0) {
    return new Set()
  }
  const provider = objectiveFilesystemProviderForTarget(target)
  const root =
    target.fileProvider || !target.gitTarget
      ? target.workspacePath
      : (resolveWorktreeHostPath(
          target.workspacePath,
          localGitOptionsForTarget(target.gitTarget)
        ) ?? target.workspacePath)
  const flavor = resolveLeasePathFlavor(target.executionHostId, root)
  const canonicalRoot = provider ? await provider.realpath(root) : await realpath(root)
  const entries = await mapConcurrent(
    [...paths],
    REPORTED_PATH_PROBE_CONCURRENCY,
    async (path): Promise<[string, boolean]> => {
      try {
        const candidate = flavor.join(root, ...path.split('/'))
        const canonicalCandidate = provider
          ? await provider.realpath(candidate)
          : await realpath(candidate)
        return [path, isPathInsideOrEqual(canonicalRoot, canonicalCandidate)]
      } catch (error) {
        if (isMissing(error) || isENOENT(error)) {
          return [path, false]
        }
        throw error
      }
    }
  )
  return new Set(entries.filter(([, exists]) => exists).map(([path]) => path))
}

export type ObjectiveWorkspaceChangesValidation =
  | { ok: true; changedPaths: string[] }
  /** `observedFiles` is the real workspace diff; absent only when observation itself never ran. */
  | { ok: false; reason: string; observedFiles?: string[] }

export async function validateObjectiveWorkspaceChanges(args: {
  target: ObjectiveWorkspaceTarget
  attemptFingerprint: string
  reportedFiles: readonly string[]
  writeTerritory: readonly string[]
}): Promise<ObjectiveWorkspaceChangesValidation> {
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
    return {
      ok: false,
      reason: `observed-change-outside-write-territory:${outside}`,
      observedFiles: observed
    }
  }
  if (
    new Set(args.reportedFiles).size !== args.reportedFiles.length ||
    args.reportedFiles.some((path) => !objectivePathMatchesTerritory(path, args.writeTerritory))
  ) {
    return { ok: false, reason: 'reported-files-invalid', observedFiles: observed }
  }
  const reported = [...args.reportedFiles].sort()
  const reportedSet = new Set(reported)
  if (observed.some((path) => !reportedSet.has(path))) {
    return {
      ok: false,
      reason: 'reported-files-do-not-match-observed-changes',
      observedFiles: observed
    }
  }
  const observedSet = new Set(observed)
  const unobservedReported = reported.filter((path) => !observedSet.has(path))
  // Ignored paths are invisible to Git; the owning host must still prove existence and containment.
  let acknowledged: Set<string>
  try {
    const ignored = await ignoredReportedPaths(args.target, unobservedReported)
    acknowledged = await existingContainedPaths(args.target, ignored)
  } catch {
    return {
      ok: false,
      reason: 'objective-workspace-observation-failed',
      observedFiles: observed
    }
  }
  if (unobservedReported.some((path) => !acknowledged.has(path))) {
    return {
      ok: false,
      reason: 'reported-files-do-not-match-observed-changes',
      observedFiles: observed
    }
  }
  return { ok: true, changedPaths: reported }
}
