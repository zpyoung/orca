import type { LedgerImportAnchor, LedgerLocationBase } from './ledger'

/** Build the durable, origin-qualified key used by legacy imports. */
export function ledgerSourceAnchor(
  base: LedgerLocationBase,
  sourcePath: string,
  legacyId: string
): string {
  const kind = base.kind
  const id = base.id
  const host = kind === 'workspace' ? (normalizeHost(base.host) ?? '') : null
  return JSON.stringify([kind, id, host, normalizeSourcePath(sourcePath), legacyId])
}

/** Resolve a Project key through persisted same-codebase equivalence classes. */
export function canonicalLedgerSourceAnchor(
  anchor: string,
  equivalences: readonly (readonly string[])[]
): string {
  const parsed = parseAnchor(anchor)
  if (!parsed || parsed[0] !== 'project') {
    return anchor
  }
  const equivalent = new Set<string>([parsed[1]])
  let changed = true
  while (changed) {
    changed = false
    for (const group of equivalences) {
      if (!group.some((id) => equivalent.has(id))) {
        continue
      }
      for (const id of group) {
        if (!equivalent.has(id)) {
          equivalent.add(id)
          changed = true
        }
      }
    }
  }
  const canonical = [...equivalent].sort()[0]
  return canonical === parsed[1]
    ? anchor
    : JSON.stringify([parsed[0], canonical, parsed[2], parsed[3], parsed[4]])
}

/** Return whether two anchors collide after applying Project equivalences. */
export function ledgerSourceAnchorsCollide(
  left: string,
  right: string,
  equivalences: readonly (readonly string[])[]
): boolean {
  return (
    canonicalLedgerSourceAnchor(left, equivalences) ===
    canonicalLedgerSourceAnchor(right, equivalences)
  )
}

export function canonicalizeLedgerImportAnchors(
  anchors: Record<string, LedgerImportAnchor>,
  equivalences: readonly (readonly string[])[]
): { anchors: Record<string, LedgerImportAnchor>; collision?: string } {
  const result: Record<string, LedgerImportAnchor> = {}
  for (const [anchor, value] of Object.entries(anchors)) {
    const canonical = canonicalLedgerSourceAnchor(anchor, equivalences)
    if (result[canonical]) {
      return { anchors, collision: canonical }
    }
    result[canonical] = value
  }
  return { anchors: result }
}

function parseAnchor(anchor: string): [string, string, string | null, string, string] | undefined {
  try {
    const value: unknown = JSON.parse(anchor)
    if (
      !Array.isArray(value) ||
      value.length !== 5 ||
      value.some((item) => typeof item !== 'string' && item !== null)
    ) {
      return undefined
    }
    if (
      typeof value[0] !== 'string' ||
      typeof value[1] !== 'string' ||
      (value[2] !== null && typeof value[2] !== 'string') ||
      typeof value[3] !== 'string' ||
      typeof value[4] !== 'string'
    ) {
      return undefined
    }
    return value as [string, string, string | null, string, string]
  } catch {
    return undefined
  }
}

function normalizeHost(host: string | undefined): string | null {
  if (!host) {
    return null
  }
  return host.trim().toLowerCase()
}

function normalizeSourcePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/$/, '')
}
