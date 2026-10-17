import { LOOP_NO_PROGRESS_ITERATIONS, type IterationRecord } from './loop-types'

function outcomeSignature(record: IterationRecord): string {
  const { check } = record
  return check ? `${check.pass}|${check.exitCode}|${check.timedOut}` : 'no-check'
}

function outputSignature(record: IterationRecord): string | null {
  const { check } = record
  return check ? `${check.exitCode}|${check.stdoutTail}|${check.stderrTail}` : null
}

function settledWindow(
  history: IterationRecord[],
  latest: IterationRecord | null
): IterationRecord[] {
  const settled = history.filter((record) => record.endReason === 'settled')
  const latestMissing =
    latest !== null &&
    latest.endReason === 'settled' &&
    !settled.some((record) => record.n === latest.n && record.attempt === latest.attempt)
  return (latest && latestMissing ? [...settled, latest] : settled).slice(
    -LOOP_NO_PROGRESS_ITERATIONS
  )
}

/**
 * True when the last `LOOP_NO_PROGRESS_ITERATIONS` settled iterations changed nothing and produced
 * the same check outcome. Without tree snapshots (folder workspaces) the check output itself must
 * be identical; with neither there is no signal, so the answer is false.
 */
export function isNoProgress(history: IterationRecord[], latest: IterationRecord | null): boolean {
  const window = settledWindow(history, latest)
  if (window.length < LOOP_NO_PROGRESS_ITERATIONS) {
    return false
  }
  if (new Set(window.map(outcomeSignature)).size !== 1) {
    return false
  }
  const treed = window.filter((record) => record.treeBefore !== null && record.treeAfter !== null)
  if (treed.some((record) => record.treeBefore !== record.treeAfter)) {
    return false
  }
  if (treed.length === window.length && window.every((record) => record.check === null)) {
    return true
  }
  const signatures = window.map(outputSignature)
  if (signatures.some((signature) => signature === null)) {
    return false
  }
  return new Set(signatures).size === 1
}

function normalizeRepoPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^(\.\/)+/, '')
}

// an uncompilable class (e.g. an out-of-order range) falls back to a literal `[` so matching never throws
function toCharacterClass(body: string): string | null {
  const negated = body.startsWith('!') || body.startsWith('^')
  const source = `[${negated ? '^' : ''}${(negated ? body.slice(1) : body).replace(/[\\\]]/g, '\\$&')}]`
  try {
    new RegExp(source)
  } catch {
    return null
  }
  return source
}

function globToRegExp(glob: string): RegExp {
  const pattern = normalizeRepoPath(glob)
  const expanded = pattern.endsWith('/') ? `${pattern}**` : pattern
  let source = ''
  let braceDepth = 0
  for (let i = 0; i < expanded.length; i++) {
    const char = expanded.charAt(i)
    if (char === '*') {
      if (expanded[i + 1] === '*') {
        const followedBySlash = expanded[i + 2] === '/'
        source += followedBySlash ? '(?:.*/)?' : '.*'
        i += followedBySlash ? 2 : 1
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else if (char === '[') {
      const close = expanded.indexOf(']', i + 2)
      const characterClass = close === -1 ? null : toCharacterClass(expanded.slice(i + 1, close))
      if (characterClass === null) {
        source += '\\['
      } else {
        source += characterClass
        i = close
      }
    } else if (char === '{') {
      braceDepth++
      source += '(?:'
    } else if (char === '}' && braceDepth > 0) {
      braceDepth--
      source += ')'
    } else if (char === ',' && braceDepth > 0) {
      source += '|'
    } else {
      source += char.replace(/[.+^$()|\\/]/g, '\\$&')
    }
  }
  source += ')'.repeat(braceDepth)
  return new RegExp(`^${source}$`)
}

/**
 * Returns the changed files that match any protected glob. Paths and globs are repo-relative; `\`
 * is accepted as a separator in paths and a trailing `/` on a glob means everything beneath it.
 */
export function protectedPathHits(changedFiles: string[], globs: string[]): string[] {
  if (globs.length === 0) {
    return []
  }
  const matchers = globs.map(globToRegExp)
  return changedFiles.filter((file) => {
    const normalized = normalizeRepoPath(file)
    return matchers.some((matcher) => matcher.test(normalized))
  })
}
