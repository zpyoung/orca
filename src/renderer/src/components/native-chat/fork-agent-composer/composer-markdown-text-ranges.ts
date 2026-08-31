export type ComposerMarkdownTextRange = {
  start: number
  end: number
}

export function findComposerMarkdownRangeAtPosition(
  ranges: readonly ComposerMarkdownTextRange[],
  position: number
): ComposerMarkdownTextRange | null {
  let lower = 0
  let upper = ranges.length - 1
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2)
    const range = ranges[middle]
    if (position < range.start) {
      upper = middle - 1
    } else if (position >= range.end) {
      lower = middle + 1
    } else {
      return range
    }
  }
  return null
}

export function composerMarkdownRangesContainPosition(
  ranges: readonly ComposerMarkdownTextRange[],
  position: number
): boolean {
  return findComposerMarkdownRangeAtPosition(ranges, position) !== null
}

export function composerMarkdownRangeIntersectsAny(
  range: ComposerMarkdownTextRange,
  candidates: readonly ComposerMarkdownTextRange[]
): boolean {
  let lower = 0
  let upper = candidates.length
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2)
    if (candidates[middle].end <= range.start) {
      lower = middle + 1
    } else {
      upper = middle
    }
  }
  return lower < candidates.length && candidates[lower].start < range.end
}

export function mergeComposerMarkdownTextRanges(
  ranges: readonly ComposerMarkdownTextRange[]
): ComposerMarkdownTextRange[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: ComposerMarkdownTextRange[] = []
  for (const range of sorted) {
    const previous = merged.at(-1)
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}
