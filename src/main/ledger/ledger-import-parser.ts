import type {
  LedgerEntryType,
  LedgerImportRecord,
  LedgerImportSkip,
  LedgerLocationBase
} from '../../shared/ledger'
import { ledgerSourceAnchor } from '../../shared/ledger-source-identity'
import { parseFrontmatter, splitAdrSections } from './ledger-import-adr-markdown'
import { parseTables } from './ledger-import-markdown-tables'
import { splitSections } from './ledger-import-markdown-sections'
import { normalizeParagraph } from './ledger-import-markdown-values'

type Source = { path: string; content: string }
type Parsed = {
  type: LedgerEntryType
  legacyId?: string
  title?: string
  fields: Record<string, string>
  sourcePath: string
}

const FILE_TYPES: Record<string, LedgerEntryType> = {
  'BUGS.md': 'bug',
  'DEFERRED.md': 'deferred',
  'TEST_BACKLOG.md': 'test-gap',
  'proposals.md': 'proposal'
}

const REQUIRED: Record<LedgerEntryType, string[]> = {
  bug: ['title', 'file', 'description', 'severity'],
  deferred: ['title', 'why_deferred', 'priority'],
  'test-gap': ['title', 'file_under_test', 'reason_skipped'],
  proposal: ['title', 'context', 'recommendation'],
  decision: ['title', 'context', 'decision', 'consequences', 'status']
}

const SEVERITIES = new Set(['critical', 'high', 'medium', 'low'])
const PRIORITIES = new Set(['high', 'medium', 'low'])
const DECISION_STATUSES = new Set(['proposed', 'accepted', 'superseded'])

export function parseLedgerImportSources(
  sources: Source[],
  base: LedgerLocationBase
): { records: LedgerImportRecord[]; skipped: LedgerImportSkip[] } {
  const records: LedgerImportRecord[] = []
  const skipped: LedgerImportSkip[] = []
  const seen = new Map<string, Parsed>()

  for (const source of sources) {
    if (!source.content?.trim()) {
      continue
    }
    const sourcePath = normalizeSourcePath(source.path)
    const type = typeForSource(sourcePath)
    if (!type) {
      continue
    }
    const parsed =
      type === 'decision'
        ? parseAdr(source.content, sourcePath)
        : parseLegacyDocument(source.content, type, sourcePath)
    for (const item of parsed) {
      const anchor = ledgerSourceAnchor(
        base,
        sourcePath,
        item.legacyId ?? (item.type === 'decision' ? sourcePath : '')
      )
      if (!item.legacyId && item.type !== 'decision') {
        skipped.push({ anchor, sourcePath, reason: 'missing explicit legacy id' })
        continue
      }
      const invalid = validateParsed(item)
      if (invalid) {
        skipped.push({ anchor, sourcePath, reason: invalid })
        continue
      }
      const previous = seen.get(anchor)
      if (previous) {
        skipped.push({ anchor, sourcePath, reason: 'duplicate or ambiguous import anchor' })
        continue
      }
      seen.set(anchor, item)
      const content = normalizeContent(item, base)
      records.push({
        anchor,
        type: item.type,
        content,
        sourcePath,
        sourceBase: base,
        legacyId: item.legacyId
      })
    }
  }

  // An anchor is ambiguous even when the duplicate was malformed; never partially import it.
  const counts = new Map<string, number>()
  for (const record of records) {
    counts.set(record.anchor, (counts.get(record.anchor) ?? 0) + 1)
  }
  for (const skip of skipped) {
    if (skip.anchor) {
      counts.set(skip.anchor, (counts.get(skip.anchor) ?? 0) + 1)
    }
  }
  const ambiguous = new Set([...counts].filter(([, count]) => count > 1).map(([anchor]) => anchor))
  if (ambiguous.size) {
    for (const anchor of ambiguous) {
      const index = records.findIndex((record) => record.anchor === anchor)
      if (index !== -1) {
        records.splice(index, 1)
      }
      if (!skipped.some((skip) => skip.anchor === anchor && skip.reason.includes('duplicate'))) {
        skipped.push({ anchor, reason: 'duplicate or ambiguous import anchor' })
      }
    }
  }
  return { records, skipped }
}

function typeForSource(sourcePath: string): LedgerEntryType | undefined {
  const normalized = sourcePath.toLowerCase()
  if (normalized.startsWith('docs/adr/') && normalized.endsWith('.md')) {
    return 'decision'
  }
  const name = sourcePath.slice(sourcePath.lastIndexOf('/') + 1)
  return Object.entries(FILE_TYPES).find(
    ([candidate]) => candidate.toLowerCase() === name.toLowerCase()
  )?.[1]
}

function parseLegacyDocument(
  markdown: string,
  type: LedgerEntryType,
  sourcePath: string
): Parsed[] {
  const sections = splitSections(markdown)
  const tables = parseTables(markdown)
  return [
    ...tables.map((fields) => parsedFromFields(type, fields, sourcePath)),
    ...sections.map((section) =>
      parsedFromFields(type, section.fields, sourcePath, section.legacyId, section.title)
    )
  ]
}

function parseAdr(markdown: string, sourcePath: string): Parsed[] {
  const fields = parseFrontmatter(markdown)
  const sections = splitAdrSections(markdown)
  const title = fields.title || sections.title
  const content: Record<string, string> = { ...sections.fields, ...fields }
  delete content.id
  delete content.title
  return [
    {
      type: 'decision',
      sourcePath,
      legacyId: fields.id || sections.id,
      title,
      fields: { ...content, ...(title ? { title } : {}) }
    }
  ]
}

function parsedFromFields(
  type: LedgerEntryType,
  fields: Record<string, string>,
  sourcePath: string,
  legacyId?: string,
  title?: string
): Parsed {
  const content: Record<string, string> = { ...fields }
  const explicitId = legacyId || content.id
  delete content.id
  return {
    type,
    sourcePath,
    legacyId: explicitId,
    title: title || content.title,
    fields: { ...content, ...(title && !content.title ? { title } : {}) }
  }
}

function normalizeContent(item: Parsed, base: LedgerLocationBase): Record<string, unknown> {
  const content: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(item.fields)) {
    content[key] = normalizeParagraph(value)
  }
  if (typeof content.severity === 'string') {
    content.severity = content.severity.toLowerCase()
  }
  if (typeof content.priority === 'string') {
    content.priority = content.priority.toLowerCase()
  }
  if (typeof content.status === 'string') {
    content.status = content.status.toLowerCase()
  }
  if (item.title && !content.title) {
    content.title = normalizeParagraph(item.title)
  }
  if (item.type === 'bug' && typeof content.file === 'string') {
    content.file = parseLocation(content.file, base)
  }
  if (item.type === 'test-gap' && typeof content.file_under_test === 'string') {
    content.file_under_test = parseLocation(content.file_under_test, base)
  }
  return content
}

function parseLocation(value: string, base: LedgerLocationBase): Record<string, unknown> {
  const match = /^(.*?)(?::(\d+))?$/.exec(value.trim())!
  return { path: match[1].trim(), ...(match[2] ? { line: Number(match[2]) } : {}), base }
}

function validateParsed(item: Parsed): string | undefined {
  const fields: Record<string, string> = {
    ...item.fields,
    ...(item.title ? { title: item.title } : {})
  }
  const missing = REQUIRED[item.type].filter((field) => !fields[field]?.trim())
  if (missing.length) {
    return `missing required field(s): ${missing.join(', ')}`
  }
  if (item.type === 'bug' && !SEVERITIES.has(fields.severity.trim().toLowerCase())) {
    return `invalid severity: ${fields.severity}`
  }
  if (item.type === 'deferred' && !PRIORITIES.has(fields.priority.trim().toLowerCase())) {
    return `invalid priority: ${fields.priority}`
  }
  if (item.type === 'decision' && !DECISION_STATUSES.has(fields.status.trim().toLowerCase())) {
    return `invalid decision status: ${fields.status}`
  }
  return undefined
}

function normalizeSourcePath(value: string): string {
  return normalizeRelativePath(value.replace(/\\/g, '/'))
}
function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/$/, '')
}
