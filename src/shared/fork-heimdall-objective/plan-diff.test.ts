import { describe, expect, it } from 'vitest'
import { task } from './decision-test-harness'
import { diffObjectivePlans } from './plan-diff'

describe('diffObjectivePlans', () => {
  it('reports an added task not present in the previous plan', () => {
    const previous = [task('a')]
    const next = [task('a'), task('b')]

    const diff = diffObjectivePlans(previous, next)

    expect(diff.added).toEqual(['b'])
    expect(diff.removed).toEqual([])
    expect(diff.changed).toEqual([])
    expect(diff.unchanged).toEqual(['a'])
    expect(diff.affected).toEqual(['b'])
    expect(diff.fullReviewRequired).toBe(false)
  })

  it('reports a removed task no longer present in the next plan', () => {
    const previous = [task('a'), task('b')]
    const next = [task('a')]

    const diff = diffObjectivePlans(previous, next)

    expect(diff.removed).toEqual(['b'])
    expect(diff.added).toEqual([])
    expect(diff.unchanged).toEqual(['a'])
  })

  it('reports a task changed when its canonical JSON differs, field order notwithstanding', () => {
    const previous = [task('a', { title: 'Old title' })]
    const next = [task('a', { title: 'New title' })]

    const diff = diffObjectivePlans(previous, next)

    expect(diff.changed).toEqual(['a'])
    expect(diff.unchanged).toEqual([])
  })

  it('treats a task as unchanged when its content is identical', () => {
    const previous = [task('a')]
    const next = [task('a')]

    const diff = diffObjectivePlans(previous, next)

    expect(diff.unchanged).toEqual(['a'])
    expect(diff.changed).toEqual([])
  })

  it('pulls direct and transitive dependents of a changed task into affected', () => {
    const previous = [task('a'), task('b', { deps: ['a'] }), task('c', { deps: ['b'] }), task('d')]
    const next = [
      task('a', { title: 'Changed' }),
      task('b', { deps: ['a'] }),
      task('c', { deps: ['b'] }),
      task('d')
    ]

    const diff = diffObjectivePlans(previous, next)

    expect(diff.changed).toEqual(['a'])
    expect(diff.affected).toEqual(['a', 'b', 'c'])
    expect(diff.affected).not.toContain('d')
  })

  it('pulls direct and transitive dependents of an added task into affected', () => {
    // 'c' is unchanged content but already declares the dependency 'new' will fill once added.
    const previous = [task('a'), task('c', { deps: ['new'] })]
    const next = [task('a'), task('new', { deps: [] }), task('c', { deps: ['new'] })]

    const diff = diffObjectivePlans(previous, next)

    expect(diff.added).toEqual(['new'])
    expect(diff.unchanged).toContain('c')
    expect(diff.affected).toEqual(['new', 'c'])
  })

  it('requires a full review once churn exceeds half the plan', () => {
    const previous = [task('a'), task('b'), task('c'), task('d')]
    // 2 of 4 changed is exactly half: still a delta review.
    const atBoundary = [
      task('a', { title: 'Changed' }),
      task('b', { title: 'Changed' }),
      task('c'),
      task('d')
    ]
    expect(diffObjectivePlans(previous, atBoundary).fullReviewRequired).toBe(false)

    // 3 of 4 changed crosses the 50% threshold: falls back to a full review.
    const overBoundary = [
      task('a', { title: 'Changed' }),
      task('b', { title: 'Changed' }),
      task('c', { title: 'Changed' }),
      task('d')
    ]
    expect(diffObjectivePlans(previous, overBoundary).fullReviewRequired).toBe(true)
  })

  it('counts added, removed, and changed tasks together against the larger plan size', () => {
    const previous = [task('a'), task('b')]
    // removed 'b', added 'c': churn 2 of max(2,2)=2 -> 100%, over the boundary.
    const next = [task('a'), task('c')]

    const diff = diffObjectivePlans(previous, next)

    expect(diff.added).toEqual(['c'])
    expect(diff.removed).toEqual(['b'])
    expect(diff.fullReviewRequired).toBe(true)
  })
})
