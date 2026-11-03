import { stripScrollbackAnsi } from '../native-chat-scrape-fallback'

/** Prompt glyphs both supported agent TUIs draw at the start of the input line. */
const COMPOSER_PROMPT_LINE = /^\s*([❯›])\s?(.*)$/
const CLAUDE_FRAME_LINE = /^\s*─{3,}\s*$/
const CODEX_FOOTER_LINE = /^\s*\S.*\s[·•]\s.*$/

function composerContinuationIsEmpty(lines: string[], promptIndex: number, glyph: string): boolean {
  for (let index = promptIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!
    if (
      (glyph === '❯' && CLAUDE_FRAME_LINE.test(line)) ||
      (glyph === '›' && CODEX_FOOTER_LINE.test(line))
    ) {
      return true
    }
    if (line.trim() !== '') {
      return false
    }
  }
  return true
}

/** Only an observably empty prompt confirms clearing; placeholders, edits and unreadable screens do not. */
export function agentInputLineCleared(screen: string | null | undefined): boolean {
  if (!screen) {
    return false
  }
  const lines = stripScrollbackAnsi(screen).split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = COMPOSER_PROMPT_LINE.exec(lines[index]!)
    if (match) {
      return match[2]!.trim() === '' && composerContinuationIsEmpty(lines, index, match[1]!)
    }
  }
  return false
}
