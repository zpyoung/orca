import type { ParsedMarker } from './loop-types'

const MARKER_LINE = /^LOOP_(DONE|BLOCKED|DECIDE)(?::\s*(.{1,500}))?$/
const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g')
const LEADING_NON_WORD = /^[^\p{L}\p{N}_]+/u

/**
 * Scans agent output for loop markers, one per line, in order of appearance.
 * Callers must pass only agent output, never the prompt or preamble they sent.
 */
export function parseLoopMarkers(text: string): ParsedMarker[] {
  const markers: ParsedMarker[] = []
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(ANSI_SEQUENCE, '').replace(LEADING_NON_WORD, '').trimEnd()
    const match = MARKER_LINE.exec(line)
    if (!match) {
      continue
    }
    const kind = match[1] === 'DONE' ? 'done' : match[1] === 'BLOCKED' ? 'blocked' : 'decide'
    markers.push(match[2] === undefined ? { kind } : { kind, text: match[2] })
  }
  return markers
}
