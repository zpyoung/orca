import { Lexer } from 'marked'
import { parse as parseYaml } from 'yaml'
import { appendValue, cleanInline, fieldKey, parseHeading } from './ledger-import-markdown-values'

export function parseFrontmatter(markdown: string): Record<string, string> {
  const match = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/.exec(markdown.replace(/\r\n?/g, '\n'))
  if (!match) {
    return {}
  }
  try {
    const parsed = parseYaml(match[1]) as Record<string, unknown> | null
    return Object.fromEntries(
      Object.entries(parsed ?? {})
        .filter(([, value]) => typeof value === 'string')
        .map(([key, value]) => [fieldKey(key), String(value)])
    )
  } catch {
    return {}
  }
}

export function splitAdrSections(markdown: string): {
  id?: string
  title?: string
  fields: Record<string, string>
} {
  const fields: Record<string, string> = {}
  let id: string | undefined
  let title: string | undefined
  let active: string | undefined
  for (const token of Lexer.lex(markdown)) {
    if (token.type === 'heading') {
      const value = cleanInline(token.text)
      const key = fieldKey(value)
      if (!title && token.depth === 1) {
        const heading = parseHeading(value)
        id = heading.id
        title = heading.title || value
      } else if (
        token.depth === 2 &&
        ['title', 'context', 'decision', 'consequences', 'status'].includes(key)
      ) {
        active = key
      } else if (active) {
        fields[active] = appendValue(fields[active], token.raw.trim())
      }
      continue
    }
    if (active && 'raw' in token) {
      fields[active] = appendValue(
        fields[active],
        token.type === 'code' ? token.raw : token.raw.trim()
      )
    }
  }
  return { id, title, fields }
}
