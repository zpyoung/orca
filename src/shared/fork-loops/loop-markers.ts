import type { ParsedMarker } from './loop-types'

const MARKER_LINE = /^LOOP_(DONE|BLOCKED|DECIDE)(?::\s*(.{1,500}))?$/
const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g')
const LEADING_NON_WORD = /^[^\p{L}\p{N}_]+/u

function normalizeLine(rawLine: string): string {
  return rawLine.replace(ANSI_SEQUENCE, '').replace(LEADING_NON_WORD, '').trimEnd()
}

function markerOf(line: string): ParsedMarker | null {
  const match = MARKER_LINE.exec(line)
  if (!match) {
    return null
  }
  const kind = match[1] === 'DONE' ? 'done' : match[1] === 'BLOCKED' ? 'blocked' : 'decide'
  return match[2] === undefined ? { kind } : { kind, text: match[2] }
}

/**
 * Scans agent output for loop markers, one per line, in order of appearance.
 * Callers must pass only agent output, never the prompt or preamble they sent.
 */
export function parseLoopMarkers(text: string): ParsedMarker[] {
  const markers: ParsedMarker[] = []
  for (const rawLine of text.split('\n')) {
    const marker = markerOf(normalizeLine(rawLine))
    if (marker) {
      markers.push(marker)
    }
  }
  return markers
}

/**
 * Scans a raw terminal tail for markers the agent printed, skipping the echo of the prompt that
 * was sent. Everything up to the echo's last line is dropped; when the echo cannot be located
 * (scrolled off or re-wrapped), a marker line that the prompt itself contains is ignored instead.
 */
export function parseAgentTailMarkers(
  tail: string,
  sentPrompt: string | undefined
): ParsedMarker[] {
  const promptLines = (sentPrompt ?? '')
    .split('\n')
    .map(normalizeLine)
    .filter((line) => line.length > 0)
  const lastPromptLine = promptLines.at(-1)
  if (!lastPromptLine) {
    return parseLoopMarkers(tail)
  }
  const lines = tail.split('\n')
  const echoEnd = lines.findLastIndex((line) => normalizeLine(line).includes(lastPromptLine))
  if (echoEnd !== -1) {
    return parseLoopMarkers(lines.slice(echoEnd + 1).join('\n'))
  }
  const markers: ParsedMarker[] = []
  for (const rawLine of lines) {
    const line = normalizeLine(rawLine)
    const marker = markerOf(line)
    if (marker && !promptLines.some((promptLine) => promptLine.startsWith(line))) {
      markers.push(marker)
    }
  }
  return markers
}
