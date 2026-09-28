import { describe, expect, it } from 'vitest'
import { searchMinimalOmissionPrefix } from './omission-budget-search'

/** `fitsStateBudget` becomes true once at least `fitsAt` units are dropped. */
function projector(fitsAt: number) {
  const calls: number[] = []
  return {
    calls,
    project: (prefix: number) => {
      calls.push(prefix)
      return { fitsStateBudget: prefix >= fitsAt, prefix }
    }
  }
}

describe('searchMinimalOmissionPrefix', () => {
  it('is null when there is nothing to drop', () => {
    expect(searchMinimalOmissionPrefix(0, projector(0).project)).toBeNull()
  })

  it('finds the minimal prefix that fits', () => {
    const { project } = projector(4)
    const found = searchMinimalOmissionPrefix(10, project)
    expect(found?.prefix).toBe(4)
  })

  it('returns the full prefix when nothing smaller fits', () => {
    const { project } = projector(10)
    const found = searchMinimalOmissionPrefix(10, project)
    expect(found?.prefix).toBe(10)
  })

  it('returns the full prefix, unfit, when dropping everything still does not fit', () => {
    const { project } = projector(11)
    const found = searchMinimalOmissionPrefix(10, project)
    expect(found?.prefix).toBe(10)
    expect(found?.result.fitsStateBudget).toBe(false)
  })

  it('never calls project more than a binary search would', () => {
    const { project, calls } = projector(6)
    searchMinimalOmissionPrefix(1_000, project)
    expect(calls.length).toBeLessThanOrEqual(Math.ceil(Math.log2(1_000)) + 2)
  })
})
