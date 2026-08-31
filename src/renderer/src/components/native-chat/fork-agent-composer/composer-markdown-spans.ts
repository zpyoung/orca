import {
  tokenizeComposerMarkdownInline,
  type ComposerMarkdownDecoration
} from './composer-markdown-inline-spans'
import {
  createComposerMarkdownParseBudget,
  isComposerMarkdownParseBudgetExceeded,
  type ComposerMarkdownParseBudget
} from './composer-markdown-parse-budget'

export type ComposerMarkdownSpanKind =
  | 'plain'
  | 'marker'
  | 'bold'
  | 'italic'
  | 'strike'
  | 'code'
  | 'fence'
  | 'heading'
  | 'quote'
  | 'list-marker'
  | 'link-text'
  | 'link-url'
  | 'mention'
  | 'command'
  | 'skill'

export type ComposerMarkdownSpan = {
  start: number
  end: number
  kinds: ComposerMarkdownSpanKind[]
}
type Decoration = ComposerMarkdownDecoration

type FenceState = {
  marker: '`' | '~'
  length: number
}

const KIND_ORDER: readonly ComposerMarkdownSpanKind[] = [
  'marker',
  'bold',
  'italic',
  'strike',
  'code',
  'fence',
  'heading',
  'quote',
  'list-marker',
  'link-text',
  'link-url',
  'mention',
  'command',
  'skill'
]

/** Returns flat, ordered spans for the composer's supported block and inline Markdown subset. */
export function tokenizeComposerMarkdown(text: string): ComposerMarkdownSpan[] {
  if (text.length === 0) {
    return []
  }

  const budget = createComposerMarkdownParseBudget()
  try {
    return tokenizeComposerMarkdownWithinBudget(text, budget)
  } catch (error) {
    if (isComposerMarkdownParseBudgetExceeded(error)) {
      return [{ start: 0, end: text.length, kinds: ['plain'] }]
    }
    throw error
  }
}

function tokenizeComposerMarkdownWithinBudget(
  text: string,
  budget: ComposerMarkdownParseBudget
): ComposerMarkdownSpan[] {
  const decorations: Decoration[] = []
  let fence: FenceState | null = null
  let lineStart = 0

  while (lineStart < text.length) {
    const newline = text.indexOf('\n', lineStart)
    const physicalEnd = newline === -1 ? text.length : newline
    const lineEnd = text[physicalEnd - 1] === '\r' ? physicalEnd - 1 : physicalEnd
    const line = text.slice(lineStart, lineEnd)

    if (fence) {
      addDecoration(decorations, lineStart, lineEnd, 'fence')
      const closingFence = parseClosingFence(line)
      if (
        closingFence &&
        closingFence.marker === fence.marker &&
        closingFence.length >= fence.length
      ) {
        fence = null
      }
    } else {
      const openingFence = parseOpeningFence(line)
      if (openingFence) {
        addDecoration(decorations, lineStart, lineEnd, 'fence')
        fence = openingFence
      } else {
        tokenizeLine(text, lineStart, lineEnd, decorations, budget)
      }
    }

    if (newline === -1) {
      break
    }
    lineStart = newline + 1
  }

  return flattenDecorations(text.length, decorations)
}

function parseOpeningFence(line: string): FenceState | null {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) {
    return null
  }
  return { marker: match[1][0] as FenceState['marker'], length: match[1].length }
}

function parseClosingFence(line: string): FenceState | null {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})[\t ]*$/)
  return match ? { marker: match[1][0] as FenceState['marker'], length: match[1].length } : null
}

function tokenizeLine(
  text: string,
  start: number,
  end: number,
  decorations: Decoration[],
  budget: ComposerMarkdownParseBudget
): void {
  const line = text.slice(start, end)
  const heading = line.match(/^( {0,3})(#{1,6})(?:[\t ]+|$)/)
  if (heading) {
    const markerStart = start + heading[1].length
    const contentStart = start + heading[0].length
    addDecoration(decorations, markerStart, markerStart + heading[2].length, 'marker')
    addDecoration(decorations, contentStart, end, 'heading')
    tokenizeComposerMarkdownInline(text, contentStart, end, decorations, budget)
    return
  }

  const quote = line.match(/^( {0,3})(>)(?:[\t ]?)/)
  if (quote) {
    const markerStart = start + quote[1].length
    const contentStart = start + quote[0].length
    addDecoration(decorations, markerStart, markerStart + 1, 'marker')
    addDecoration(decorations, contentStart, end, 'quote')
    tokenizeComposerMarkdownInline(text, contentStart, end, decorations, budget)
    return
  }

  const list = line.match(/^([\t ]{0,3})([-+*]|\d+[.)])([\t ]+)/)
  if (list) {
    const markerStart = start + list[1].length
    const contentStart = start + list[0].length
    addDecoration(decorations, markerStart, markerStart + list[2].length, 'list-marker')
    tokenizeComposerMarkdownInline(text, contentStart, end, decorations, budget)
    return
  }

  tokenizeComposerMarkdownInline(text, start, end, decorations, budget)
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

function flattenDecorations(
  length: number,
  decorations: readonly Decoration[]
): ComposerMarkdownSpan[] {
  const events = new Map<number, Map<Decoration['kind'], number>>()
  for (const decoration of decorations) {
    recordEvent(events, decoration.start, decoration.kind, 1)
    recordEvent(events, decoration.end, decoration.kind, -1)
  }

  const boundaries = [...new Set([0, length, ...events.keys()])].sort((left, right) => left - right)
  const active = new Map<Decoration['kind'], number>()
  const spans: ComposerMarkdownSpan[] = []

  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index]
    const end = boundaries[index + 1]
    for (const [kind, delta] of events.get(start) ?? []) {
      active.set(kind, (active.get(kind) ?? 0) + delta)
    }

    const activeKinds = KIND_ORDER.filter(
      (kind): kind is Decoration['kind'] => kind !== 'plain' && (active.get(kind) ?? 0) > 0
    )
    const kinds = activeKinds.includes('marker') ? ['marker' as const] : activeKinds
    appendSpan(spans, { start, end, kinds: kinds.length > 0 ? kinds : ['plain'] })
  }

  return spans
}

function recordEvent(
  events: Map<number, Map<Decoration['kind'], number>>,
  position: number,
  kind: Decoration['kind'],
  delta: number
): void {
  const atPosition = events.get(position) ?? new Map<Decoration['kind'], number>()
  atPosition.set(kind, (atPosition.get(kind) ?? 0) + delta)
  events.set(position, atPosition)
}

function appendSpan(spans: ComposerMarkdownSpan[], next: ComposerMarkdownSpan): void {
  if (next.start >= next.end) {
    return
  }
  const previous = spans.at(-1)
  if (previous && previous.end === next.start && sameKinds(previous.kinds, next.kinds)) {
    previous.end = next.end
    return
  }
  spans.push(next)
}

function sameKinds(
  left: readonly ComposerMarkdownSpanKind[],
  right: readonly ComposerMarkdownSpanKind[]
): boolean {
  return left.length === right.length && left.every((kind, index) => kind === right[index])
}
