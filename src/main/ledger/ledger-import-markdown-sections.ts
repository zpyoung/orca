import { Lexer } from 'marked'
import {
  appendPreserving,
  appendValue,
  parseHeading,
  parseLabel,
  fieldKey
} from './ledger-import-markdown-values'

type LegacySection = {
  legacyId?: string
  title?: string
  fields: Record<string, string>
}

export function splitSections(markdown: string): LegacySection[] {
  const sections: LegacySection[] = []
  let current: LegacySection | undefined
  let active: string | undefined
  let inFence = false
  const addText = (text: string, preserveIndent = false) => {
    for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
      const label = parseLabel(line)
      if (label) {
        current ??= { fields: {} }
        active = fieldKey(label.key)
        current.fields[active] = appendValue(current.fields[active], label.value)
      } else if (active && current) {
        const fence = /^\s*(`{3,}|~{3,})/.exec(line)
        const preserved =
          preserveIndent || inFence || Boolean(fence) ? line : line.replace(/^ {2}/, '')
        current.fields[active] = appendPreserving(current.fields[active], preserved)
        if (fence) {
          inFence = !inFence
        }
      }
    }
  }

  for (const token of Lexer.lex(markdown)) {
    if (token.type === 'heading' && token.depth <= 2) {
      if (current && Object.keys(current.fields).length) {
        sections.push(current)
      }
      const parsed = parseHeading(token.text)
      current = { legacyId: parsed.id, title: parsed.title, fields: {} }
      active = undefined
      continue
    }
    if (token.type !== 'table' && 'raw' in token) {
      addText(token.type === 'code' ? `\n${token.raw}` : token.raw, token.type === 'code')
    }
  }
  if (current && Object.keys(current.fields).length) {
    sections.push(current)
  }
  return sections
}
