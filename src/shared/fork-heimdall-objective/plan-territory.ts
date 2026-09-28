import { segmentMatches } from './plan-schema'

function isDoubleStarSegment(segment: string): boolean {
  return segment === '**'
}

function isWildcardSegment(segment: string): boolean {
  return !isDoubleStarSegment(segment) && /[*?]/u.test(segment)
}

/**
 * Sound-not-complete: `true` guarantees every path matching `inner` also matches `outer`. A `false`
 * result may still describe a real containment the DP's conservative alignment rules cannot see.
 */
export function objectiveGlobWithin(inner: string, outer: string): boolean {
  const innerParts = inner.split('/')
  const outerParts = outer.split('/')
  const memo = new Map<string, boolean>()

  const align = (innerIndex: number, outerIndex: number): boolean => {
    const key = `${innerIndex}:${outerIndex}`
    const cached = memo.get(key)
    if (cached !== undefined) {
      return cached
    }
    const result = computeAlignment(innerIndex, outerIndex)
    memo.set(key, result)
    return result
  }

  const computeAlignment = (innerIndex: number, outerIndex: number): boolean => {
    if (outerIndex === outerParts.length) {
      return innerIndex === innerParts.length
    }
    const outerSegment = outerParts[outerIndex]
    if (isDoubleStarSegment(outerSegment)) {
      return (
        align(innerIndex, outerIndex + 1) ||
        (innerIndex < innerParts.length && align(innerIndex + 1, outerIndex))
      )
    }
    if (innerIndex === innerParts.length) {
      return false
    }
    const innerSegment = innerParts[innerIndex]
    const aligns = isDoubleStarSegment(innerSegment)
      ? false
      : isWildcardSegment(innerSegment)
        ? outerSegment === '*' || outerSegment === innerSegment
        : segmentMatches(outerSegment, innerSegment)
    return aligns && align(innerIndex + 1, outerIndex + 1)
  }

  return align(0, 0)
}

/** Every glob in `inner` must be within some glob in `outer` (see `objectiveGlobWithin`). */
export function objectiveTerritoryWithin(
  inner: readonly string[],
  outer: readonly string[]
): boolean {
  return inner.every((innerGlob) =>
    outer.some((outerGlob) => objectiveGlobWithin(innerGlob, outerGlob))
  )
}

function wildcardPrefix(segment: string): string {
  const index = segment.search(/[*?]/u)
  return index === -1 ? segment : segment.slice(0, index)
}

function wildcardSuffix(segment: string): string {
  let index = -1
  for (let position = 0; position < segment.length; position += 1) {
    if (segment[position] === '*' || segment[position] === '?') {
      index = position
    }
  }
  return index === -1 ? segment : segment.slice(index + 1)
}

function prefixCompatible(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a)
}

function suffixCompatible(a: string, b: string): boolean {
  return a.endsWith(b) || b.endsWith(a)
}

function segmentsOverlap(a: string, b: string): boolean {
  const aIsWildcard = isWildcardSegment(a)
  const bIsWildcard = isWildcardSegment(b)
  if (!aIsWildcard) {
    return segmentMatches(b, a)
  }
  if (!bIsWildcard) {
    return segmentMatches(a, b)
  }
  return (
    prefixCompatible(wildcardPrefix(a), wildcardPrefix(b)) &&
    suffixCompatible(wildcardSuffix(a), wildcardSuffix(b))
  )
}

/**
 * Complete-not-sound: `false` guarantees no path matches both globs. A `true` result may over-report
 * a conflict the DP's segment-overlap heuristic cannot rule out.
 */
export function objectiveGlobsOverlap(a: string, b: string): boolean {
  const aParts = a.split('/')
  const bParts = b.split('/')
  const memo = new Map<string, boolean>()

  const match = (aIndex: number, bIndex: number): boolean => {
    const key = `${aIndex}:${bIndex}`
    const cached = memo.get(key)
    if (cached !== undefined) {
      return cached
    }
    const result = computeMatch(aIndex, bIndex)
    memo.set(key, result)
    return result
  }

  const computeMatch = (aIndex: number, bIndex: number): boolean => {
    if (aIndex === aParts.length && bIndex === bParts.length) {
      return true
    }
    if (aIndex === aParts.length) {
      return bParts.slice(bIndex).every(isDoubleStarSegment)
    }
    if (bIndex === bParts.length) {
      return aParts.slice(aIndex).every(isDoubleStarSegment)
    }
    const aSegment = aParts[aIndex]
    const bSegment = bParts[bIndex]
    if (isDoubleStarSegment(aSegment) && (match(aIndex + 1, bIndex) || match(aIndex, bIndex + 1))) {
      return true
    }
    if (isDoubleStarSegment(bSegment) && (match(aIndex, bIndex + 1) || match(aIndex + 1, bIndex))) {
      return true
    }
    if (isDoubleStarSegment(aSegment) || isDoubleStarSegment(bSegment)) {
      return false
    }
    return segmentsOverlap(aSegment, bSegment) && match(aIndex + 1, bIndex + 1)
  }

  return match(0, 0)
}

/** Any glob in `a` overlapping any glob in `b` (see `objectiveGlobsOverlap`). */
export function objectiveTerritoriesOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.some((aGlob) => b.some((bGlob) => objectiveGlobsOverlap(aGlob, bGlob)))
}
