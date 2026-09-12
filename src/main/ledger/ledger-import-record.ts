import { createLedgerEntry, mutateLedgerEntry } from './ledger-entry-mutations'
import { canonicalLedgerSourceAnchor } from '../../shared/ledger-source-identity'
import type {
  LedgerActor,
  LedgerImportAnchor,
  LedgerImportRecord,
  LedgerMutationContext,
  LedgerRecord
} from '../../shared/ledger'

export type LedgerImportApplyResult = {
  status: 'created' | 'updated' | 'already-present' | 'skipped'
  entryId?: string
  reason?: string
  changed: boolean
}

/** Apply one parsed record; the caller owns the surrounding atomic commit. */
export function applyLedgerImportRecord(
  record: LedgerRecord,
  source: LedgerImportRecord,
  context: LedgerMutationContext,
  now: string
): LedgerImportApplyResult {
  const canonical = canonicalLedgerSourceAnchor(source.anchor, record.sourceEquivalences)
  const matches = Object.entries(record.importAnchors).filter(
    ([key]) => canonicalLedgerSourceAnchor(key, record.sourceEquivalences) === canonical
  )
  if (matches.length > 1) {
    return { status: 'skipped', reason: 'canonical-anchor-collision', changed: false }
  }
  const matched = matches[0]
  const matchedAnchor = matched?.[1]
  if (matchedAnchor?.deleted) {
    return { status: 'skipped', reason: 'deleted', changed: false }
  }

  const entry = matchedAnchor?.entryId
    ? record.entries.find((candidate) => candidate.id === matchedAnchor.entryId)
    : undefined
  const importContext = importMutationContext(context, source.anchor)
  if (!entry) {
    const created = createLedgerEntry(record, source.type, source.content, importContext, now)
    record.importAnchors[source.anchor] = {
      entryId: created.id,
      baseline: cloneValue(source.content),
      sourcePath: source.sourcePath,
      sourceBase: source.sourceBase,
      legacyId: source.legacyId
    }
    return { status: 'created', entryId: created.id, changed: true }
  }

  const baseline = matchedAnchor?.baseline ?? {}
  const currentImported = projectImportedContent(entry.content, baseline, source.content)
  if (semanticEqual(source.content, baseline)) {
    return { status: 'already-present', entryId: entry.id, changed: false }
  }
  if (semanticEqual(currentImported, source.content)) {
    updateBaseline(matchedAnchor, source)
    record.revision += 1
    return { status: 'already-present', entryId: entry.id, changed: true }
  }
  if (!semanticEqual(currentImported, baseline)) {
    return { status: 'skipped', entryId: entry.id, reason: 'conflict', changed: false }
  }

  const nextContent = cloneValue(entry.content)
  for (const key of Object.keys(baseline)) {
    if (!Object.hasOwn(source.content, key)) {
      delete nextContent[key]
    }
  }
  Object.assign(nextContent, cloneValue(source.content))
  const result = mutateLedgerEntry(
    record,
    {
      operation: 'edit',
      id: entry.id,
      ifRevision: entry.revision,
      content: nextContent
    },
    importContext,
    now,
    { replaceContent: true }
  )
  if (!result.changed) {
    return { status: 'already-present', entryId: entry.id, changed: false }
  }
  updateBaseline(matchedAnchor, source)
  return { status: 'updated', entryId: entry.id, changed: true }
}

function importMutationContext(
  context: LedgerMutationContext,
  sourceAnchor: string
): LedgerMutationContext {
  const initiator =
    context.actor.kind === 'import'
      ? context.actor.initiator
      : context.actor.kind === 'agent' || context.actor.kind === 'unknown'
        ? context.actor
        : undefined
  const actor: LedgerActor = {
    ...context.actor,
    kind: 'import',
    sourceAnchor,
    ...(initiator ? { initiator } : {})
  }
  return { ...context, actor }
}

function updateBaseline(anchor: LedgerImportAnchor | undefined, source: LedgerImportRecord): void {
  if (!anchor) {
    return
  }
  anchor.baseline = cloneValue(source.content)
  anchor.sourcePath = source.sourcePath
  anchor.sourceBase = source.sourceBase
  anchor.legacyId = source.legacyId
}

function projectImportedContent(
  current: Record<string, unknown>,
  baseline: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const keys = new Set([...Object.keys(baseline), ...Object.keys(source)])
  return Object.fromEntries([...keys].sort().map((key) => [key, current[key]]))
}

function semanticEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right))
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalize)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, normalize((value as Record<string, unknown>)[key])])
    )
  }
  return value
}

function cloneValue<T>(value: T): T {
  if (value === undefined) {
    return value
  }
  return JSON.parse(JSON.stringify(value)) as T
}
