import type { ObjectiveLandingBar } from './contract-types'
import type { ObjectiveLandingProjection } from './detail-types'

export const OBJECTIVE_LANDING_LADDER = [
  'files-on-disk',
  'committed-local-branch',
  'pushed-ref',
  'hosted-review',
  'merged'
] as const satisfies readonly ObjectiveLandingBar[]

function rungIndex(rung: ObjectiveLandingBar): number {
  return OBJECTIVE_LANDING_LADDER.indexOf(rung)
}

export function highestReachedRung(
  landing: readonly ObjectiveLandingProjection[],
  contentIdentity: string
): ObjectiveLandingBar | null {
  let highestIndex = -1
  for (const entry of landing) {
    if (entry.contentIdentity === contentIdentity) {
      highestIndex = Math.max(highestIndex, rungIndex(entry.rung))
    }
  }
  return highestIndex < 0 ? null : OBJECTIVE_LANDING_LADDER[highestIndex]
}

export function reachedRungs(
  landing: readonly ObjectiveLandingProjection[],
  contentIdentity: string
): ReadonlySet<ObjectiveLandingBar> {
  const highest = highestReachedRung(landing, contentIdentity)
  if (highest === null) {
    return new Set()
  }
  return new Set(OBJECTIVE_LANDING_LADDER.slice(0, rungIndex(highest) + 1))
}

export function lineageBaseIdentity(
  landing: readonly ObjectiveLandingProjection[],
  contentIdentity: string
): string {
  const highest = highestReachedRung(landing, contentIdentity)
  if (highest === null) {
    return contentIdentity
  }

  let identity = contentIdentity
  for (let index = rungIndex(highest); index >= 0; index -= 1) {
    let latest: ObjectiveLandingProjection | undefined
    for (const entry of landing) {
      if (
        entry.rung === OBJECTIVE_LANDING_LADDER[index] &&
        entry.contentIdentity === identity &&
        (latest === undefined || entry.atMs > latest.atMs)
      ) {
        latest = entry
      }
    }
    if (latest?.fromContentIdentity !== undefined) {
      identity = latest.fromContentIdentity
    }
  }
  return identity
}

export function stopRungForBar(bar: ObjectiveLandingBar): ObjectiveLandingBar {
  return bar === 'merged' ? 'hosted-review' : bar
}

export function nextRung(
  reached: ObjectiveLandingBar | null,
  bar: ObjectiveLandingBar
): ObjectiveLandingBar | null {
  const stopIndex = rungIndex(stopRungForBar(bar))
  const nextIndex = reached === null ? 0 : rungIndex(reached) + 1
  return nextIndex > stopIndex ? null : OBJECTIVE_LANDING_LADDER[nextIndex]
}
