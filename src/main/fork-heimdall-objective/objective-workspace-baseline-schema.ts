import type { GitWorkspaceObservation, ObjectiveWorkspaceTarget } from './content-identity'
import type { ObjectiveWorkspaceManifestEntry } from './objective-workspace-manifest-digest'

export const LEGACY_BASELINE_VERSION = 1
export const GIT_BASELINE_VERSION = 2

// fingerprintDirtyPath returns tagged strings rather than a bare digest, and a nested repository
// folds another identity into its own; this bounds that nesting without pinning a shape.
const MAX_DIRTY_FINGERPRINT_CHARS = 512

export type BaselineTarget = {
  kind: ObjectiveWorkspaceTarget['kind']
  executionHostId: string
  workspacePath: string
  gitWorktreeId: string | null
}

export type LegacyWorkspaceBaseline = {
  version: typeof LEGACY_BASELINE_VERSION
  attemptFingerprint: string
  target: BaselineTarget
  entries: ObjectiveWorkspaceManifestEntry[]
}

export type GitWorkspaceBaseline = {
  version: typeof GIT_BASELINE_VERSION
  attemptFingerprint: string
  target: BaselineTarget
  git: GitWorkspaceObservation
}

export type WorkspaceBaseline = LegacyWorkspaceBaseline | GitWorkspaceBaseline

export function targetDescriptor(target: ObjectiveWorkspaceTarget): BaselineTarget {
  return {
    kind: target.kind,
    executionHostId: target.executionHostId,
    workspacePath: target.workspacePath,
    gitWorktreeId: target.kind === 'git' ? (target.gitTarget?.worktree.id ?? null) : null
  }
}

export function sameTarget(left: BaselineTarget, right: BaselineTarget): boolean {
  return (
    left.kind === right.kind &&
    left.executionHostId === right.executionHostId &&
    left.workspacePath === right.workspacePath &&
    left.gitWorktreeId === right.gitWorktreeId
  )
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
}

function parseTarget(input: unknown): BaselineTarget | null {
  if (
    !isRecord(input) ||
    !exactKeys(input, ['kind', 'executionHostId', 'workspacePath', 'gitWorktreeId'])
  ) {
    return null
  }
  const { kind, executionHostId, workspacePath, gitWorktreeId } = input
  if (
    (kind !== 'git' && kind !== 'folder') ||
    typeof executionHostId !== 'string' ||
    typeof workspacePath !== 'string' ||
    (gitWorktreeId !== null && typeof gitWorktreeId !== 'string')
  ) {
    return null
  }
  return { kind, executionHostId, workspacePath, gitWorktreeId }
}

function parseAscendingEntries<T>(
  input: unknown,
  parseEntry: (entry: Record<string, unknown>) => T | null
): T[] | null {
  if (!Array.isArray(input)) {
    return null
  }
  const parsed: T[] = []
  let previousPath: string | null = null
  for (const rawEntry of input) {
    if (
      !isRecord(rawEntry) ||
      !exactKeys(rawEntry, ['path', 'fingerprint']) ||
      typeof rawEntry.path !== 'string'
    ) {
      return null
    }
    if (previousPath !== null && rawEntry.path <= previousPath) {
      return null
    }
    const value = parseEntry(rawEntry)
    if (value === null) {
      return null
    }
    parsed.push(value)
    previousPath = rawEntry.path
  }
  return parsed
}

function parseLegacyBaseline(value: Record<string, unknown>): LegacyWorkspaceBaseline | null {
  if (!exactKeys(value, ['version', 'attemptFingerprint', 'target', 'entries'])) {
    return null
  }
  const target = parseTarget(value.target)
  const entries = parseAscendingEntries(value.entries, (entry) =>
    typeof entry.path === 'string' &&
    typeof entry.fingerprint === 'string' &&
    /^[0-9a-f]{64}$/u.test(entry.fingerprint)
      ? ({ path: entry.path, fingerprint: entry.fingerprint } as const)
      : null
  )
  if (!target || !entries) {
    return null
  }
  return { version: LEGACY_BASELINE_VERSION, attemptFingerprint: '', target, entries }
}

function parseGitBaseline(value: Record<string, unknown>): GitWorkspaceBaseline | null {
  if (!exactKeys(value, ['version', 'attemptFingerprint', 'target', 'git'])) {
    return null
  }
  const target = parseTarget(value.target)
  const git = value.git
  if (!target || target.kind !== 'git' || !isRecord(git) || !exactKeys(git, ['treeOid', 'dirty'])) {
    return null
  }
  if (typeof git.treeOid !== 'string' || !/^(?:unborn|[0-9a-f]{40,64})$/u.test(git.treeOid)) {
    return null
  }
  const dirty = parseAscendingEntries(git.dirty, (entry) =>
    typeof entry.path === 'string' &&
    typeof entry.fingerprint === 'string' &&
    entry.fingerprint.length > 0 &&
    entry.fingerprint.length <= MAX_DIRTY_FINGERPRINT_CHARS
      ? ({ path: entry.path, fingerprint: entry.fingerprint } as const)
      : null
  )
  if (!dirty) {
    return null
  }
  return {
    version: GIT_BASELINE_VERSION,
    attemptFingerprint: '',
    target,
    git: { treeOid: git.treeOid, dirty }
  }
}

export function parseBaseline(input: unknown): WorkspaceBaseline | null {
  if (!isRecord(input) || typeof input.attemptFingerprint !== 'string') {
    return null
  }
  const parsed =
    input.version === LEGACY_BASELINE_VERSION
      ? parseLegacyBaseline(input)
      : input.version === GIT_BASELINE_VERSION
        ? parseGitBaseline(input)
        : null
  return parsed === null ? null : { ...parsed, attemptFingerprint: input.attemptFingerprint }
}
