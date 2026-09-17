import type { GitWorkspaceObservation } from './content-identity'
import type { ObjectiveWorkspaceTarget } from './content-identity'
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

function asRecord(input: unknown): Record<string, unknown> | null {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null
}

function parseTarget(input: unknown): BaselineTarget | null {
  const raw = asRecord(input)
  if (!raw || !exactKeys(raw, ['kind', 'executionHostId', 'workspacePath', 'gitWorktreeId'])) {
    return null
  }
  if (
    (raw.kind !== 'git' && raw.kind !== 'folder') ||
    typeof raw.executionHostId !== 'string' ||
    typeof raw.workspacePath !== 'string' ||
    (raw.gitWorktreeId !== null && typeof raw.gitWorktreeId !== 'string')
  ) {
    return null
  }
  return raw as BaselineTarget
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
    const entry = asRecord(rawEntry)
    if (!entry || !exactKeys(entry, ['path', 'fingerprint']) || typeof entry.path !== 'string') {
      return null
    }
    if (previousPath !== null && entry.path <= previousPath) {
      return null
    }
    const value = parseEntry(entry)
    if (value === null) {
      return null
    }
    parsed.push(value)
    previousPath = entry.path
  }
  return parsed
}

function parseLegacyBaseline(value: Record<string, unknown>): LegacyWorkspaceBaseline | null {
  if (!exactKeys(value, ['version', 'attemptFingerprint', 'target', 'entries'])) {
    return null
  }
  const target = parseTarget(value.target)
  const entries = parseAscendingEntries(value.entries, (entry) =>
    typeof entry.fingerprint === 'string' && /^[0-9a-f]{64}$/u.test(entry.fingerprint)
      ? ({ path: entry.path as string, fingerprint: entry.fingerprint } as const)
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
  const git = asRecord(value.git)
  if (!target || target.kind !== 'git' || !git || !exactKeys(git, ['treeOid', 'dirty'])) {
    return null
  }
  if (typeof git.treeOid !== 'string' || !/^(?:unborn|[0-9a-f]{40,64})$/u.test(git.treeOid)) {
    return null
  }
  const dirty = parseAscendingEntries(git.dirty, (entry) =>
    typeof entry.fingerprint === 'string' &&
    entry.fingerprint.length > 0 &&
    entry.fingerprint.length <= MAX_DIRTY_FINGERPRINT_CHARS
      ? ({ path: entry.path as string, fingerprint: entry.fingerprint } as const)
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
  const value = asRecord(input)
  if (!value || typeof value.attemptFingerprint !== 'string') {
    return null
  }
  const parsed =
    value.version === LEGACY_BASELINE_VERSION
      ? parseLegacyBaseline(value)
      : value.version === GIT_BASELINE_VERSION
        ? parseGitBaseline(value)
        : null
  return parsed === null ? null : { ...parsed, attemptFingerprint: value.attemptFingerprint }
}
