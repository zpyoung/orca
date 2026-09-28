import { describe, expect, it } from 'vitest'
import type { ObjectiveLandingBar } from './contract-types'
import type { ObjectiveLandingProjection } from './detail-types'
import {
  OBJECTIVE_LANDING_LADDER,
  highestReachedRung,
  lineageBaseIdentity,
  nextRung,
  reachedRungs,
  stopRungForBar
} from './landing-ladder'

function landing(
  rung: ObjectiveLandingBar,
  contentIdentity: string,
  fromContentIdentity?: string,
  atMs = 1
): ObjectiveLandingProjection {
  return {
    rung,
    revisionId: 'revision-1',
    contentIdentity,
    ...(fromContentIdentity === undefined ? {} : { fromContentIdentity }),
    atMs
  }
}

describe('objective landing ladder', () => {
  it('folds only rows at the current identity while preserving the full lower ladder', () => {
    const rows = [
      landing('files-on-disk', 'content-base'),
      landing('committed-local-branch', 'content-current', 'content-base', 2),
      landing('pushed-ref', 'content-current', 'content-current', 3),
      landing('hosted-review', 'content-current', 'content-current', 4),
      landing('merged', 'content-stray', 'content-stray', 5)
    ]

    expect([...reachedRungs(rows, 'content-current')]).toEqual([
      'files-on-disk',
      'committed-local-branch',
      'pushed-ref',
      'hosted-review'
    ])
    expect(highestReachedRung(rows, 'content-current')).toBe('hosted-review')
    expect([...reachedRungs(rows, 'content-base')]).toEqual(['files-on-disk'])
    expect(highestReachedRung(rows, 'content-missing')).toBeNull()
  })

  it('follows the three-rung lineage back to the identity that supplied checks and review', () => {
    const rows = [
      landing('files-on-disk', 'checked-content'),
      landing('committed-local-branch', 'committed-content', 'checked-content', 2),
      landing('pushed-ref', 'committed-content', 'committed-content', 3),
      landing('hosted-review', 'committed-content', 'committed-content', 4),
      landing('committed-local-branch', 'other-content', 'unrelated-content', 5)
    ]

    expect(lineageBaseIdentity(rows, 'committed-content')).toBe('checked-content')
    expect(lineageBaseIdentity(rows, 'other-content')).toBe('unrelated-content')
    expect(lineageBaseIdentity(rows, 'unknown-content')).toBe('unknown-content')
  })

  it('maps merged to the hosted-review handoff stop and advances every reached/bar pair', () => {
    expect(stopRungForBar('merged')).toBe('hosted-review')
    const reached: readonly (ObjectiveLandingBar | null)[] = [null, ...OBJECTIVE_LANDING_LADDER]
    const expected: Record<ObjectiveLandingBar, readonly (ObjectiveLandingBar | null)[]> = {
      'files-on-disk': ['files-on-disk', null, null, null, null, null],
      'committed-local-branch': ['files-on-disk', 'committed-local-branch', null, null, null, null],
      'pushed-ref': ['files-on-disk', 'committed-local-branch', 'pushed-ref', null, null, null],
      'hosted-review': [
        'files-on-disk',
        'committed-local-branch',
        'pushed-ref',
        'hosted-review',
        null,
        null
      ],
      merged: ['files-on-disk', 'committed-local-branch', 'pushed-ref', 'hosted-review', null, null]
    }

    for (const bar of OBJECTIVE_LANDING_LADDER) {
      expect(reached.map((rung) => nextRung(rung, bar))).toEqual(expected[bar])
    }
  })
})
