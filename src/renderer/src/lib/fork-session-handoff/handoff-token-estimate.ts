type HandoffContentClass = 'prose' | 'code' | 'diff'

type OpenFence = {
  marker: '`' | '~'
  length: number
  contentClass: Exclude<HandoffContentClass, 'prose'>
}

const CHARS_PER_TOKEN: Record<HandoffContentClass, number> = {
  prose: 6.5,
  code: 4.5,
  diff: 3.5
}

/** Estimates brief tokens using separate ratios for prose, code, and diff content. */
export function estimateHandoffTokens(text: string): number {
  if (!text) {
    return 0
  }

  const charCounts: Record<HandoffContentClass, number> = { prose: 0, code: 0, diff: 0 }
  let openFence: OpenFence | null = null

  for (const chunk of text.match(/[^\n]*(?:\n|$)/g) ?? []) {
    if (!chunk) {
      continue
    }
    const line = chunk.endsWith('\n') ? chunk.slice(0, -1).replace(/\r$/, '') : chunk

    if (openFence) {
      charCounts[openFence.contentClass] += chunk.length
      if (isClosingFence(line, openFence)) {
        openFence = null
      }
      continue
    }

    const openedFence = parseOpeningFence(line)
    if (openedFence) {
      openFence = openedFence
      charCounts[openedFence.contentClass] += chunk.length
      continue
    }

    charCounts[isDiffLine(line) ? 'diff' : 'prose'] += chunk.length
  }

  const estimate = (Object.keys(charCounts) as HandoffContentClass[]).reduce(
    (total, contentClass) => total + charCounts[contentClass] / CHARS_PER_TOKEN[contentClass],
    0
  )
  return Math.max(1, Math.ceil(estimate))
}

function parseOpeningFence(line: string): OpenFence | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
  if (!match) {
    return null
  }
  const run = match[1]
  const info = match[2].trim().toLowerCase()
  return {
    marker: run[0] as '`' | '~',
    length: run.length,
    contentClass: info === 'diff' || info === 'patch' ? 'diff' : 'code'
  }
}

function isClosingFence(line: string, fence: OpenFence): boolean {
  const match = /^ {0,3}(`+|~+)\s*$/.exec(line)
  return Boolean(match && match[1][0] === fence.marker && match[1].length >= fence.length)
}

function isDiffLine(line: string): boolean {
  return /^(?:diff --git |index [0-9a-f]+\.[0-9a-f]+|@@ .* @@|--- (?:a\/|\/dev\/null)|\+\+\+ (?:b\/|\/dev\/null)|[+-](?![+-]\s|\s))/.test(
    line
  )
}
