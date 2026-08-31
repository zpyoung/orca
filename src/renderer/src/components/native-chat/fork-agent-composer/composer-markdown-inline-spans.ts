import type { ComposerMarkdownSpanKind } from './composer-markdown-spans'
import {
  spendComposerMarkdownParseBudget,
  type ComposerMarkdownParseBudget
} from './composer-markdown-parse-budget'
import {
  composerMarkdownRangeIntersectsAny as intersectsAny,
  composerMarkdownRangesContainPosition as containsPosition,
  findComposerMarkdownRangeAtPosition as rangeAtPosition,
  mergeComposerMarkdownTextRanges as mergeTextRanges,
  type ComposerMarkdownTextRange as TextRange
} from './composer-markdown-text-ranges'

export type ComposerMarkdownDecoration = {
  start: number
  end: number
  kind: Exclude<ComposerMarkdownSpanKind, 'plain'>
}

type Decoration = ComposerMarkdownDecoration

const MAX_EMPHASIS_NESTING = 64

export function tokenizeComposerMarkdownInline(
  text: string,
  start: number,
  end: number,
  decorations: Decoration[],
  budget: ComposerMarkdownParseBudget
): void {
  if (start >= end) {
    return
  }

  const codeRanges = tokenizeInlineCode(text, start, end, decorations)
  const { opaqueRanges, linkRanges } = tokenizeLinks(
    text,
    start,
    end,
    decorations,
    codeRanges,
    budget
  )
  tokenizeEmphasis(text, start, end, decorations, opaqueRanges, budget)
  tokenizeOrcaTokens(
    text,
    start,
    end,
    decorations,
    mergeTextRanges([...opaqueRanges, ...linkRanges])
  )
}

function tokenizeInlineCode(
  text: string,
  start: number,
  end: number,
  decorations: Decoration[]
): TextRange[] {
  const ranges: TextRange[] = []
  let cursor = start

  while (cursor < end) {
    if (text[cursor] !== '`') {
      cursor += 1
      continue
    }

    const openingEnd = endOfRun(text, cursor, end, '`')
    if (isEscaped(text, cursor)) {
      cursor = openingEnd
      continue
    }
    const delimiterLength = openingEnd - cursor
    let closingStart = openingEnd

    while (closingStart < end) {
      closingStart = text.indexOf('`', closingStart)
      if (closingStart === -1 || closingStart >= end) {
        break
      }
      const closingEnd = endOfRun(text, closingStart, end, '`')
      if (!isEscaped(text, closingStart) && closingEnd - closingStart === delimiterLength) {
        addDecoration(decorations, cursor, openingEnd, 'marker')
        addDecoration(decorations, openingEnd, closingStart, 'code')
        addDecoration(decorations, closingStart, closingEnd, 'marker')
        ranges.push({ start: cursor, end: closingEnd })
        cursor = closingEnd
        break
      }
      closingStart = closingEnd
    }

    if (cursor < openingEnd) {
      cursor = openingEnd
    }
  }

  return ranges
}

function tokenizeLinks(
  text: string,
  start: number,
  end: number,
  decorations: Decoration[],
  codeRanges: readonly TextRange[],
  budget: ComposerMarkdownParseBudget
): { opaqueRanges: TextRange[]; linkRanges: TextRange[] } {
  const opaqueRanges: TextRange[] = [...codeRanges]
  const linkRanges: TextRange[] = []
  let cursor = start

  while (cursor < end) {
    const opening = text.indexOf('[', cursor)
    if (opening === -1 || opening >= end) {
      break
    }
    if (isEscaped(text, opening) || containsPosition(codeRanges, opening)) {
      cursor = opening + 1
      continue
    }

    const transition = findLinkTransition(text, opening + 1, end, codeRanges)
    if (transition === -1) {
      break
    }
    const closing = findLinkClosingParen(text, transition + 2, end, budget)
    if (closing === -1) {
      cursor = transition + 2
      continue
    }

    addDecoration(decorations, opening, opening + 1, 'marker')
    addDecoration(decorations, opening + 1, transition, 'link-text')
    addDecoration(decorations, transition, transition + 2, 'marker')
    addDecoration(decorations, transition + 2, closing, 'link-url')
    addDecoration(decorations, closing, closing + 1, 'marker')
    opaqueRanges.push(
      { start: opening, end: opening + 1 },
      { start: transition, end: transition + 2 },
      { start: transition + 2, end: closing },
      { start: closing, end: closing + 1 }
    )
    linkRanges.push({ start: opening, end: closing + 1 })
    cursor = closing + 1
  }

  const urlBlockers = mergeTextRanges([...codeRanges, ...linkRanges])
  const urlPattern = /https?:\/\/[^\s<]+/g
  urlPattern.lastIndex = start
  let match = urlPattern.exec(text)
  while (match && match.index < end) {
    const urlStart = match.index
    let urlEnd = Math.min(urlPattern.lastIndex, end)
    urlEnd = trimBareUrlEnd(text, urlStart, urlEnd)
    if (urlEnd > urlStart && !intersectsAny({ start: urlStart, end: urlEnd }, urlBlockers)) {
      addDecoration(decorations, urlStart, urlEnd, 'link-url')
      opaqueRanges.push({ start: urlStart, end: urlEnd })
    }
    match = urlPattern.exec(text)
  }

  return { opaqueRanges: mergeTextRanges(opaqueRanges), linkRanges }
}

function findLinkTransition(
  text: string,
  start: number,
  end: number,
  codeRanges: readonly TextRange[]
): number {
  let cursor = start
  while (cursor < end - 1) {
    const transition = text.indexOf('](', cursor)
    if (transition === -1 || transition >= end - 1) {
      return -1
    }
    if (!isEscaped(text, transition) && !containsPosition(codeRanges, transition)) {
      return transition
    }
    cursor = transition + 2
  }
  return -1
}

function findLinkClosingParen(
  text: string,
  start: number,
  end: number,
  budget: ComposerMarkdownParseBudget
): number {
  let depth = 0
  for (let cursor = start; cursor < end; cursor += 1) {
    spendComposerMarkdownParseBudget(budget)
    const character = text[cursor]
    if (/\s/.test(character)) {
      return -1
    }
    if (character === '(' && !isEscaped(text, cursor)) {
      depth += 1
    } else if (character === ')' && !isEscaped(text, cursor)) {
      if (depth === 0) {
        return cursor
      }
      depth -= 1
    }
  }
  return -1
}

function trimBareUrlEnd(text: string, start: number, end: number): number {
  let trimmedEnd = end
  while (trimmedEnd > start && /[.,!?;:]/.test(text[trimmedEnd - 1])) {
    trimmedEnd -= 1
  }

  let parenthesisBalance = 0
  for (let cursor = start; cursor < trimmedEnd; cursor += 1) {
    if (text[cursor] === '(') {
      parenthesisBalance += 1
    } else if (text[cursor] === ')') {
      parenthesisBalance -= 1
    }
  }
  while (trimmedEnd > start && text[trimmedEnd - 1] === ')' && parenthesisBalance < 0) {
    trimmedEnd -= 1
    parenthesisBalance += 1
  }
  return trimmedEnd
}

function tokenizeEmphasis(
  text: string,
  start: number,
  end: number,
  decorations: Decoration[],
  opaqueRanges: readonly TextRange[],
  budget: ComposerMarkdownParseBudget,
  depth = 0
): void {
  if (depth >= MAX_EMPHASIS_NESTING) {
    return
  }
  const unavailableDelimiters = new Set<string>()
  let cursor = start

  while (cursor < end) {
    const opaqueRange = rangeAtPosition(opaqueRanges, cursor)
    if (opaqueRange) {
      cursor = opaqueRange.end
      continue
    }

    const delimiter = emphasisDelimiterAt(text, cursor, end)
    if (
      !delimiter ||
      unavailableDelimiters.has(delimiter.value) ||
      isEscaped(text, cursor) ||
      !canOpenDelimiter(text, cursor, delimiter.value.length, end)
    ) {
      cursor += 1
      continue
    }

    const closing = findClosingDelimiter(
      text,
      cursor + delimiter.value.length,
      end,
      delimiter.value,
      opaqueRanges,
      budget
    )
    if (closing === -1) {
      unavailableDelimiters.add(delimiter.value)
      cursor += delimiter.value.length
      continue
    }

    const openingEnd = cursor + delimiter.value.length
    addDecoration(decorations, cursor, openingEnd, 'marker')
    addDecorationExcluding(decorations, openingEnd, closing, delimiter.kinds, opaqueRanges)
    addDecoration(decorations, closing, closing + delimiter.value.length, 'marker')
    tokenizeEmphasis(text, openingEnd, closing, decorations, opaqueRanges, budget, depth + 1)
    cursor = closing + delimiter.value.length
  }
}

function emphasisDelimiterAt(
  text: string,
  position: number,
  end: number
): { value: string; kinds: Decoration['kind'][] } | null {
  if (position > 0 && text[position - 1] === text[position]) {
    return null
  }

  const triple = text.slice(position, position + 3)
  if (
    (triple === '***' || triple === '___') &&
    position + 3 <= end &&
    text[position + 3] !== text[position]
  ) {
    return { value: triple, kinds: ['bold', 'italic'] }
  }

  const pair = text.slice(position, position + 2)
  if (
    (pair === '**' || pair === '__') &&
    position + 2 <= end &&
    text[position + 2] !== text[position]
  ) {
    return { value: pair, kinds: ['bold'] }
  }
  if (pair === '~~' && position + 2 <= end && text[position + 2] !== '~') {
    return { value: pair, kinds: ['strike'] }
  }

  const character = text[position]
  if ((character === '*' || character === '_') && text[position + 1] !== character) {
    return { value: character, kinds: ['italic'] }
  }
  return null
}

function findClosingDelimiter(
  text: string,
  start: number,
  end: number,
  delimiter: string,
  opaqueRanges: readonly TextRange[],
  budget: ComposerMarkdownParseBudget
): number {
  let cursor = start
  while (cursor <= end - delimiter.length) {
    spendComposerMarkdownParseBudget(budget)
    const closing = text.indexOf(delimiter, cursor)
    if (closing === -1 || closing > end - delimiter.length) {
      return -1
    }
    if (
      !isEscaped(text, closing) &&
      !containsPosition(opaqueRanges, closing) &&
      isExactDelimiterRun(text, closing, delimiter) &&
      canCloseDelimiter(text, closing, delimiter.length, start)
    ) {
      return closing
    }
    cursor = closing + delimiter.length
  }
  return -1
}

function isExactDelimiterRun(text: string, start: number, delimiter: string): boolean {
  const character = delimiter[0]
  return text[start - 1] !== character && text[start + delimiter.length] !== character
}

function canOpenDelimiter(text: string, start: number, length: number, end: number): boolean {
  const after = start + length
  if (after >= end || /\s/.test(text[after])) {
    return false
  }
  if (text[start] === '_') {
    const before = start > 0 ? text[start - 1] : ''
    return !(isWordCharacter(before) && isWordCharacter(text[after]))
  }
  return true
}

function canCloseDelimiter(
  text: string,
  start: number,
  length: number,
  lowerBound: number
): boolean {
  if (start <= lowerBound || /\s/.test(text[start - 1])) {
    return false
  }
  if (text[start] === '_') {
    const after = start + length < text.length ? text[start + length] : ''
    return !(isWordCharacter(text[start - 1]) && isWordCharacter(after))
  }
  return true
}

function tokenizeOrcaTokens(
  text: string,
  start: number,
  end: number,
  decorations: Decoration[],
  opaqueRanges: readonly TextRange[]
): void {
  const tokenPattern = /(^|\s)([@/$])\S*/g
  const line = text.slice(start, end)
  let match = tokenPattern.exec(line)

  while (match) {
    const tokenStart = start + match.index + match[1].length
    const tokenEnd = start + tokenPattern.lastIndex
    const kind = match[2] === '@' ? 'mention' : match[2] === '/' ? 'command' : ('skill' as const)
    addDecorationExcluding(decorations, tokenStart, tokenEnd, [kind], opaqueRanges)
    match = tokenPattern.exec(line)
  }
}

function addDecoration(
  decorations: Decoration[],
  start: number,
  end: number,
  kind: Decoration['kind']
): void {
  if (start < end) {
    decorations.push({ start, end, kind })
  }
}

function addDecorationExcluding(
  decorations: Decoration[],
  start: number,
  end: number,
  kinds: readonly Decoration['kind'][],
  excluded: readonly TextRange[]
): void {
  let cursor = start

  for (const range of excluded) {
    if (range.end <= start) {
      continue
    }
    if (range.start >= end) {
      break
    }
    const rangeStart = Math.max(range.start, start)
    if (rangeStart > cursor) {
      for (const kind of kinds) {
        addDecoration(decorations, cursor, rangeStart, kind)
      }
    }
    cursor = Math.max(cursor, Math.min(range.end, end))
  }

  if (cursor < end) {
    for (const kind of kinds) {
      addDecoration(decorations, cursor, end, kind)
    }
  }
}

function endOfRun(text: string, start: number, end: number, character: string): number {
  let cursor = start
  while (cursor < end && text[cursor] === character) {
    cursor += 1
  }
  return cursor
}

function isEscaped(text: string, position: number): boolean {
  let backslashes = 0
  for (let cursor = position - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
    backslashes += 1
  }
  return backslashes % 2 === 1
}

function isWordCharacter(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value)
}
