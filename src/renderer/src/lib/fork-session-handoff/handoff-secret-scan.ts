export type SecretScanHit = {
  ruleId: string
  line: number
  start: number
  end: number
  redactedExcerpt: string
}

type SecretRule = {
  id: string
  pattern: RegExp
}

const SECRET_RULES: readonly SecretRule[] = [
  { id: 'aws-access-key-id', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { id: 'stripe-key', pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{10,}\b/g },
  { id: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  {
    id: 'private-key-header',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g
  },
  {
    id: 'env-assignment',
    pattern:
      /\b(?:api[_-]?key|secret|token|password|passwd|credential)s?\s*[=:]\s*['"]?[A-Za-z0-9_/+=-]{16,}/gi
  }
]

/** Finds precision-first secret patterns and returns only redacted display text. */
export function scanHandoffBriefForSecrets(text: string): SecretScanHit[] {
  const lineStarts = collectLineStarts(text)
  const hits = SECRET_RULES.flatMap((rule, ruleIndex) =>
    Array.from(text.matchAll(new RegExp(rule.pattern.source, rule.pattern.flags)), (match) => {
      const start = match.index
      const matchedText = match[0]
      return {
        ruleId: rule.id,
        line: lineNumberAt(lineStarts, start),
        start,
        end: start + matchedText.length,
        redactedExcerpt: `${matchedText.slice(0, 4)}…`,
        ruleIndex
      }
    })
  )

  return hits
    .sort((left, right) =>
      left.start !== right.start
        ? left.start - right.start
        : left.end !== right.end
          ? left.end - right.end
          : left.ruleIndex - right.ruleIndex
    )
    .map(({ ruleIndex: _ruleIndex, ...hit }) => hit)
}

function collectLineStarts(text: string): number[] {
  const starts = [0]
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) {
      starts.push(index + 1)
    }
  }
  return starts
}

function lineNumberAt(lineStarts: number[], offset: number): number {
  let low = 0
  let high = lineStarts.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (lineStarts[middle] <= offset) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  return low
}
