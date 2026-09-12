import {
  LedgerError,
  type LedgerEntry,
  type LedgerLocation,
  type LedgerLocationBase
} from './ledger'
import { validateLedgerLocation } from './ledger-location-validation'

type LocationContext = {
  base: LedgerLocationBase
  rootPath: string
  platform: 'win32' | 'posix'
  host: string
}
const winAbsolute = (value: string) => /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
const posixAbsolute = (value: string) => value.startsWith('/')
const positiveLine = (value: number): boolean => Number.isSafeInteger(value) && value >= 1

function slash(value: string, platform: LocationContext['platform']): string {
  return platform === 'win32' ? value.replaceAll('\\', '/') : value
}
function cleanSegments(value: string): string {
  const out: string[] = []
  for (const part of value.split('/')) {
    if (!part || part === '.') {
      continue
    }
    if (part === '..') {
      if (out.length && out.at(-1) !== '..') {
        out.pop()
      } else {
        out.push(part)
      }
    } else {
      out.push(part)
    }
  }
  return out.join('/')
}
function normalizePath(value: string, platform: LocationContext['platform']): string {
  const path = slash(value, platform)
  if (platform === 'posix') {
    return path.startsWith('/') ? `/${cleanSegments(path)}` : cleanSegments(path)
  }
  const drive = path.match(/^([A-Za-z]:)(?:\/|$)/)
  if (drive) {
    return `${drive[1]}/${cleanSegments(path.slice(drive[0].length))}`
  }
  const unc = path.match(/^\/\/([^/]+)\/([^/]+)(?:\/|$)/)
  if (unc) {
    const rest = cleanSegments(path.slice(unc[0].length))
    return `//${unc[1]}/${unc[2]}${rest ? `/${rest}` : ''}`
  }
  return cleanSegments(path)
}
function rootRelative(
  path: string,
  root: string,
  platform: LocationContext['platform']
): string | null {
  const normalizedPath = normalizePath(path, platform),
    normalizedRoot = normalizePath(root, platform).replace(/\/$/, '')
  const fold =
    platform === 'win32' ? (value: string) => value.toLowerCase() : (value: string) => value
  if (fold(normalizedPath) === fold(normalizedRoot)) {
    return ''
  }
  if (fold(normalizedPath).startsWith(`${fold(normalizedRoot)}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1)
  }
  return null
}
function relativeEscapesRoot(path: string, platform: LocationContext['platform']): boolean {
  let depth = 0
  for (const part of slash(path, platform).split('/')) {
    if (!part || part === '.') {
      continue
    }
    if (part === '..') {
      if (depth === 0) {
        return true
      }
      depth--
    } else {
      depth++
    }
  }
  return false
}
function extractRawLine(input: string): { path: string; line?: number } {
  const match = input.match(/:(\d+)$/)
  if (!match) {
    return { path: input }
  }
  const line = Number(match[1])
  if (!positiveLine(line)) {
    throw new LedgerError('invalid-location', 'Location line must be a positive safe integer')
  }
  return { path: input.slice(0, -match[0].length), line }
}
function validateContext(context: LocationContext): void {
  const absolute =
    context.platform === 'win32' ? winAbsolute(context.rootPath) : posixAbsolute(context.rootPath)
  if (!absolute || typeof context.host !== 'string' || !context.host.trim()) {
    throw new LedgerError('invalid-location', 'Location context requires an absolute root and host')
  }
}

export function normalizeLedgerPath(path: string): string {
  return normalizePath(path, 'posix')
}
export function normalizeLedgerLocation(
  input: string | LedgerLocation,
  context: LocationContext
): LedgerLocation {
  validateContext(context)
  const supplied =
    typeof input === 'string'
      ? validateLedgerLocation({ ...extractRawLine(input), base: context.base })
      : validateLedgerLocation(input)
  const original = supplied.path,
    root = normalizePath(context.rootPath, context.platform)
  const absolute = context.platform === 'win32' ? winAbsolute(original) : posixAbsolute(original)
  if (supplied.external) {
    return { ...supplied, path: normalizePath(original, context.platform), host: supplied.host }
  }
  if (!absolute && relativeEscapesRoot(original, context.platform)) {
    return {
      ...supplied,
      path: normalizePath(`${root}/${slash(original, context.platform)}`, context.platform),
      external: true,
      host: supplied.host ?? context.host
    }
  }
  const relative = absolute
    ? rootRelative(original, root, context.platform)
    : cleanSegments(slash(original, context.platform))
  if (relative === null) {
    return {
      ...supplied,
      path: normalizePath(original, context.platform),
      external: true,
      host: supplied.host ?? context.host
    }
  }
  return { ...supplied, path: relative, external: false, host: supplied.host ?? context.base.host }
}
function equivalentProjectId(
  id: string,
  sourceEquivalences: readonly (readonly string[])[]
): string {
  const equivalent = new Set([id])
  let changed = true
  while (changed) {
    changed = false
    for (const group of sourceEquivalences) {
      if (!group.some((candidate) => equivalent.has(candidate))) {
        continue
      }
      for (const candidate of group) {
        if (!equivalent.has(candidate)) {
          equivalent.add(candidate)
          changed = true
        }
      }
    }
  }
  return [...equivalent].sort()[0]
}
export function ledgerLocationKey(
  location: unknown,
  sourceEquivalences: readonly (readonly string[])[] = []
): string | null {
  if (!location || typeof location !== 'object') {
    return null
  }
  const x = location as Partial<LedgerLocation>
  if (
    typeof x.path !== 'string' ||
    !x.base ||
    typeof x.base.id !== 'string' ||
    (x.base.kind !== 'project' && x.base.kind !== 'workspace')
  ) {
    return null
  }
  if (x.external && (typeof x.host !== 'string' || !x.host.trim())) {
    return null
  }
  const scope =
    x.base.kind === 'project'
      ? `project:${equivalentProjectId(x.base.id, sourceEquivalences)}`
      : `workspace:${x.base.id}:${x.host ?? x.base.host ?? ''}`
  return `${scope}:${x.external ? `external:${x.host ?? ''}:` : ''}${normalizeLedgerPath(x.path)}`
}
function words(value: unknown): Set<string> {
  return new Set(
    String(value ?? '')
      .normalize('NFKD')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  )
}
export function ledgerEntriesNearMatch(
  entry: LedgerEntry,
  entries: readonly LedgerEntry[],
  sourceEquivalences: readonly (readonly string[])[] = []
): LedgerEntry[] {
  const title = words(entry.content.title),
    location = ledgerLocationKey(
      entry.content.file ?? entry.content.file_under_test,
      sourceEquivalences
    )
  return entries.filter((other) => {
    if (other.type !== entry.type) {
      return false
    }
    const otherLocation = ledgerLocationKey(
      other.content.file ?? other.content.file_under_test,
      sourceEquivalences
    )
    if (location && location === otherLocation) {
      return true
    }
    const otherTitle = words(other.content.title)
    const union = new Set([...title, ...otherTitle]).size
    return union > 0 && [...title].filter((word) => otherTitle.has(word)).length / union >= 0.6
  })
}
