import { createHash, type Hash } from 'node:crypto'

export const REVIEW_ARTIFACT_EXCLUSION = '.orca-review/**'
export const MAX_REVIEW_ARTIFACT_ENTRIES = 2_000
export const MAX_REVIEW_ARTIFACT_BYTES = 50 * 1024 * 1024

export type ReviewArtifactEntryKind = 'directory' | 'file' | 'symlink'

export type ReviewArtifactStat = {
  kind: ReviewArtifactEntryKind
  size?: number
  mode?: number
}

export type ReviewArtifactTreeReader = {
  readDirectory(path: string): Promise<readonly string[]>
  lstat(path: string): Promise<ReviewArtifactStat>
  readFile(path: string): Promise<Uint8Array>
  readSymbolicLink(path: string): Promise<string>
  joinPath(parent: string, name: string): string
}

export type ReviewArtifactTreeEntry = {
  path: string
  kind: ReviewArtifactEntryKind
  mode: number | null
  size: number
  contentHash: string
}

export type ReviewArtifactContentCapture = {
  strategy: 'content'
  hash: string
  entries: readonly ReviewArtifactTreeEntry[]
  exclusions: readonly string[]
  totalBytes: number
}

export type ReviewArtifactOidCapture = {
  strategy: 'oids'
  hash: string
  baselineOid: string | null
  headOid: string
  watched: readonly ('baseline' | 'head')[]
}

export type ReviewArtifactCapture = ReviewArtifactContentCapture | ReviewArtifactOidCapture

export type ReviewArtifactComparison = {
  stale: boolean
  reason: 'current' | 'hash-mismatch' | 'ref-moved'
  addedPaths: readonly string[]
  changedPaths: readonly string[]
  deletedPaths: readonly string[]
  unreviewedPaths: readonly string[]
}

export type ReviewArtifactCaptureLimits = {
  maxEntries?: number
  maxBytes?: number
}

export type ReviewArtifactTreeRecord = {
  path: string
  kind: ReviewArtifactEntryKind
  mode?: number | null
  content?: Uint8Array | string
}

const compareNames = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

function frame(hash: Hash, value: Uint8Array | string): void {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
  const length = Buffer.allocUnsafe(8)
  length.writeBigUInt64BE(BigInt(bytes.byteLength))
  hash.update(length)
  hash.update(bytes)
}

function normalizeMode(mode: number | null | undefined): string {
  return mode == null ? '' : String(mode)
}

function hashRecord(record: ReviewArtifactTreeRecord): string {
  const hash = createHash('sha256')
  frame(hash, 'orca-review-tree-entry-v1')
  frame(hash, record.kind)
  frame(hash, record.path)
  frame(hash, normalizeMode(record.mode))
  frame(hash, record.content ?? new Uint8Array())
  return hash.digest('hex')
}

export function hashReviewArtifactBytes(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

export function hashReviewArtifactDiff(
  diffText: string,
  untrackedDiffs: readonly { path: string; diffText: string }[] = []
): string {
  const hash = createHash('sha256')
  hash.update(diffText, 'utf8')
  for (const item of [...untrackedDiffs].sort((left, right) =>
    compareNames(left.path, right.path)
  )) {
    hash.update(item.diffText, 'utf8')
  }
  return hash.digest('hex')
}

export function hashReviewArtifactOids(baselineOid: string | null, headOid: string): string {
  const hash = createHash('sha256')
  frame(hash, 'orca-review-oids-v1')
  frame(hash, baselineOid ?? '')
  frame(hash, headOid)
  return hash.digest('hex')
}

export function hashReviewArtifactTree(records: readonly ReviewArtifactTreeRecord[]): string {
  const hash = createHash('sha256')
  frame(hash, 'orca-review-tree-v1')
  for (const record of [...records].sort((left, right) => compareNames(left.path, right.path))) {
    frame(hash, record.kind)
    frame(hash, record.path)
    frame(hash, normalizeMode(record.mode))
    frame(hash, record.content ?? new Uint8Array())
  }
  return hash.digest('hex')
}

function normalizePattern(pattern: string): string {
  return pattern
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/^\/+|\/+$/g, '')
}

export function reviewArtifactExclusions(generatedOutputs: readonly string[] = []): string[] {
  const patterns = [REVIEW_ARTIFACT_EXCLUSION, ...generatedOutputs]
    .map(normalizePattern)
    .filter(Boolean)
  return [...new Set(patterns)].sort(compareNames)
}

function escapeRegex(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character
}

function exclusionRegex(pattern: string): RegExp {
  let source = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '*' && pattern[index + 1] === '*') {
      const followsSlash = pattern[index + 2] === '/'
      const precededBySlash = pattern[index - 1] === '/'
      if (followsSlash) {
        source += '(?:.*/)?'
        index += 2
      } else if (precededBySlash && index + 2 === pattern.length) {
        source = `${source.slice(0, -1)}(?:/.*)?`
        index += 1
      } else {
        source += '.*'
        index += 1
      }
    } else if (character === '*') {
      source += '[^/]*'
    } else if (character === '?') {
      source += '[^/]'
    } else {
      source += escapeRegex(character)
    }
  }
  return new RegExp(`${source}$`)
}

export function isReviewArtifactPathExcluded(
  relativePath: string,
  exclusions: readonly string[]
): boolean {
  const normalizedPath = relativePath.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '')
  return exclusions.some((pattern) =>
    exclusionRegex(normalizePattern(pattern)).test(normalizedPath)
  )
}

function assertSafeEntryName(name: string): void {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error(`unsafe review artifact entry name: ${JSON.stringify(name)}`)
  }
}

export async function captureReviewArtifactTree(
  root: string,
  reader: ReviewArtifactTreeReader,
  generatedOutputs: readonly string[] = [],
  limits: ReviewArtifactCaptureLimits = {}
): Promise<ReviewArtifactContentCapture> {
  const exclusions = reviewArtifactExclusions(generatedOutputs)
  const maxEntries = limits.maxEntries ?? MAX_REVIEW_ARTIFACT_ENTRIES
  const maxBytes = limits.maxBytes ?? MAX_REVIEW_ARTIFACT_BYTES
  const records: ReviewArtifactTreeRecord[] = []
  const entries: ReviewArtifactTreeEntry[] = []
  let totalBytes = 0

  const walk = async (physicalPath: string, segments: readonly string[]): Promise<void> => {
    const names = [...(await reader.readDirectory(physicalPath))].sort(compareNames)
    for (const name of names) {
      assertSafeEntryName(name)
      const childSegments = [...segments, name]
      const relativePath = childSegments.join('/')
      if (isReviewArtifactPathExcluded(relativePath, exclusions)) {
        continue
      }
      if (entries.length >= maxEntries) {
        throw new Error(`review artifact exceeds the ${maxEntries}-entry limit`)
      }
      const childPath = reader.joinPath(physicalPath, name)
      const stat = await reader.lstat(childPath)
      const mode = stat.mode ?? null
      if (stat.kind === 'directory') {
        const record = { path: relativePath, kind: stat.kind, mode } as const
        records.push(record)
        entries.push({ ...record, size: 0, contentHash: hashRecord(record) })
        await walk(childPath, childSegments)
        continue
      }
      const content =
        stat.kind === 'symlink'
          ? await reader.readSymbolicLink(childPath)
          : await reader.readFile(childPath)
      const size =
        typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.byteLength
      if (stat.kind === 'file' && stat.size != null && stat.size !== size) {
        throw new Error(`review artifact file changed while hashing: ${relativePath}`)
      }
      totalBytes += size
      if (totalBytes > maxBytes) {
        throw new Error(`review artifact exceeds the ${maxBytes}-byte limit`)
      }
      const record = { path: relativePath, kind: stat.kind, mode, content }
      records.push(record)
      entries.push({ ...record, size, contentHash: hashRecord(record) })
    }
  }

  await walk(root, [])
  return {
    strategy: 'content',
    hash: hashReviewArtifactTree(records),
    entries,
    exclusions,
    totalBytes
  }
}

export function captureReviewArtifactOids(
  baselineOid: string | null,
  headOid: string,
  watched: readonly ('baseline' | 'head')[] = []
): ReviewArtifactOidCapture {
  return {
    strategy: 'oids',
    hash: hashReviewArtifactOids(baselineOid, headOid),
    baselineOid,
    headOid,
    watched: [...new Set(watched)]
  }
}

function compareEntries(
  captured: readonly ReviewArtifactTreeEntry[],
  observed: readonly ReviewArtifactTreeEntry[]
): Pick<ReviewArtifactComparison, 'addedPaths' | 'changedPaths' | 'deletedPaths'> {
  const before = new Map(captured.map((entry) => [entry.path, entry]))
  const after = new Map(observed.map((entry) => [entry.path, entry]))
  const addedPaths = [...after.keys()].filter((path) => !before.has(path)).sort(compareNames)
  const deletedPaths = [...before.keys()].filter((path) => !after.has(path)).sort(compareNames)
  const changedPaths = [...before.keys()]
    .filter((path) => {
      const current = after.get(path)
      const previous = before.get(path)
      return current != null && previous != null && current.contentHash !== previous.contentHash
    })
    .sort(compareNames)
  return { addedPaths, changedPaths, deletedPaths }
}

export function compareReviewArtifactCaptures(
  captured: ReviewArtifactCapture,
  observed: ReviewArtifactCapture
): ReviewArtifactComparison {
  if (captured.strategy !== observed.strategy) {
    return {
      stale: true,
      reason: 'hash-mismatch',
      addedPaths: [],
      changedPaths: [],
      deletedPaths: [],
      unreviewedPaths: []
    }
  }
  if (captured.strategy === 'oids' && observed.strategy === 'oids') {
    const moved = captured.watched.some((field) =>
      field === 'baseline'
        ? captured.baselineOid !== observed.baselineOid
        : captured.headOid !== observed.headOid
    )
    return {
      stale: moved,
      reason: moved ? 'ref-moved' : 'current',
      addedPaths: [],
      changedPaths: [],
      deletedPaths: [],
      unreviewedPaths: []
    }
  }
  if (captured.strategy !== 'content' || observed.strategy !== 'content') {
    throw new Error('unreachable review artifact comparison')
  }
  const paths = compareEntries(captured.entries, observed.entries)
  const stale = captured.hash !== observed.hash
  return {
    stale,
    reason: stale ? 'hash-mismatch' : 'current',
    ...paths,
    unreviewedPaths: paths.addedPaths
  }
}
