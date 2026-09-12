export function fieldKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '_').replace(/-+/g, '_')
}

export function appendValue(previous: string | undefined, next: string): string {
  return previous ? `${previous}\n${next}` : next
}

export function appendPreserving(previous: string | undefined, next: string): string {
  return previous === undefined ? next.trim() : `${previous}\n${next}`
}

export function normalizeParagraph(value: string): string {
  return value
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function cleanInline(value: string): string {
  return value
    .trim()
    .replace(/^`|`$/g, '')
    .replace(/\\([|\\])/g, '$1')
}

export function parseLabel(line: string): { key: string; value: string } | undefined {
  const match = /^\s*(?:[-*+]\s+)?(?:\*\*([^*]+):\*\*|([^:]+):)\s*(.*)$/.exec(line)
  return match ? { key: match[1] || match[2], value: match[3] } : undefined
}

export function parseHeading(value: string): { id?: string; title?: string } {
  const match = /^\[?([A-Za-z][A-Za-z0-9_-]*-\d+)\]?\s*[:—-]?\s*(.*)$/.exec(cleanInline(value))
  return match ? { id: match[1], title: match[2] || undefined } : { title: cleanInline(value) }
}
