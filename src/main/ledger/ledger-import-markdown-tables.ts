import { Lexer } from 'marked'
import { cleanInline, fieldKey } from './ledger-import-markdown-values'

export function parseTables(markdown: string): Record<string, string>[] {
  const result: Record<string, string>[] = []
  for (const token of Lexer.lex(markdown)) {
    if (token.type !== 'table') {
      continue
    }
    const rawRows = token.raw.split(/\r?\n/).filter((line) => line.trim())
    const headers = splitTableRow(rawRows[0] ?? '').map(fieldKey)
    const malformedHeaders =
      headers.some((header) => !header) || new Set(headers).size !== headers.length
    for (const line of rawRows.slice(2)) {
      const cells = splitTableRow(line)
      if (malformedHeaders || cells.length !== headers.length) {
        result.push({})
        continue
      }
      result.push(
        Object.fromEntries(
          headers.map((header, index) => [header, cleanInline(cells[index])])
        ) as Record<string, string>
      )
    }
  }
  return result
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim()
  const body = trimmed.startsWith('|')
    ? trimmed.slice(1, trimmed.endsWith('|') ? -1 : undefined)
    : trimmed
  const cells: string[] = []
  let start = 0
  let codeRun = 0
  let escaped = false
  for (let index = 0; index < body.length; index++) {
    const character = body[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (character === '`') {
      let end = index
      while (body[end] === '`') {
        end++
      }
      const run = end - index
      codeRun = codeRun === run ? 0 : codeRun || run
      index = end - 1
      continue
    }
    if (character === '|' && !codeRun) {
      cells.push(body.slice(start, index).trim())
      start = index + 1
    }
  }
  cells.push(body.slice(start).trim())
  return cells
}
