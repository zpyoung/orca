import { describe, expect, it } from 'vitest'
import { diffObjectivePlans } from './plan-diff'
import type { ObjectivePlanTask } from './plan-schema'

function task(overrides: Partial<ObjectivePlanTask> = {}): ObjectivePlanTask {
  return {
    taskKey: 'core',
    title: 'Core',
    spec: 'Implement the core behavior.',
    deps: [],
    criteria: [{ body: 'Works', shellCheckable: false, checkCommand: null }],
    declaresDependencyChange: false,
    ...overrides
  }
}

describe('diffObjectivePlans', () => {
  it('reports an added task not present in the previous plan', () => {
    const previous = [task({ taskKey: 'a' })]
    const next = [task({ taskKey: 'a' }), task({ taskKey: 'b' })]

    const diff = diffObjectivePlans(previous, next)

    expect(diff.added).toEqual(['b'])
    expect(diff.removed).toEqual([])
    expect(diff.changed).toEqual([])
    expect(diff.unchanged).toEqual(['a'])
    expect(diff.affected).toEqual(['b'])
    expect(diff.fullReviewRequired).toBe(false)
  })

  it('reports a removed task no longer present in the next plan', () => {
    const previous = [task({ taskKey: 'a' }), task({ taskKey: 'b' })]
    const next = [task({ taskKey: 'a' })]

    const diff = diffObjectivePlans(previous, next)

    expect(diff.removed).toEqual(['b'])
    expect(diff.added).toEqual([])
    expect(diff.unchanged).toEqual(['a'])
  })

  it('reports a task changed when its canonical JSON differs, field order notwithstanding', () => {
    const previous = [task({ taskKey: 'a', title: 'Old title' })]
    const next = [task({ taskKey: 'a', title: 'New title' })]

    const diff = diffObjectivePlans(previous, next)

    expect(diff.changed).toEqual(['a'])
    expect(diff.unchanged).toEqual([])
  })

  it('treats a task as unchanged when its content is identical', () => {
    const previous = [task({ taskKey: 'a' })]
    const next = [task({ taskKey: 'a' })]

    const diff = diffObjectivePlans(previous, next)

    expect(diff.unchanged).toEqual(['a'])
    expect(diff.changed).toEqual([])
  })

  it('pulls direct and transitive dependents of a changed task into affected', () => {
    const previous = [
      task({ taskKey: 'a' }),
      task({ taskKey: 'b', deps: ['a'] }),
      task({ taskKey: 'c', deps: ['b'] }),
      task({ taskKey: 'd' })
    ]
    const next = [
      task({ taskKey: 'a', title: 'Changed' }),
      task({ taskKey: 'b', deps: ['a'] }),
      task({ taskKey: 'c', deps: ['b'] }),
      task({ taskKey: 'd' })
    ]

    const diff = diffObjectivePlans(previous, next)

    expect(diff.changed).toEqual(['a'])
    expect(diff.affected).toEqual(['a', 'b', 'c'])
    expect(diff.affected).not.toContain('d')
  })

  it('pulls direct and transitive dependents of an added task into affected', () => {
    // 'c' is unchanged content but already declares the dependency 'new' will fill once added.
    const previous = [task({ taskKey: 'a' }), task({ taskKey: 'c', deps: ['new'] })]
    const next = [
      task({ taskKey: 'a' }),
      task({ taskKey: 'new', deps: [] }),
      task({ taskKey: 'c', deps: ['new'] })
    ]

    const diff = diffObjectivePlans(previous, next)

    expect(diff.added).toEqual(['new'])
    expect(diff.unchanged).toContain('c')
    expect(diff.affected).toEqual(['new', 'c'])
  })

  it('requires a full review once churn exceeds half the plan', () => {
    const previous = [
      task({ taskKey: 'a' }),
      task({ taskKey: 'b' }),
      task({ taskKey: 'c' }),
      task({ taskKey: 'd' })
    ]
    // 2 of 4 changed is exactly half: still a delta review.
    const atBoundary = [
      task({ taskKey: 'a', title: 'Changed' }),
      task({ taskKey: 'b', title: 'Changed' }),
      task({ taskKey: 'c' }),
      task({ taskKey: 'd' })
    ]
    expect(diffObjectivePlans(previous, atBoundary).fullReviewRequired).toBe(false)

    // 3 of 4 changed crosses the 50% threshold: falls back to a full review.
    const overBoundary = [
      task({ taskKey: 'a', title: 'Changed' }),
      task({ taskKey: 'b', title: 'Changed' }),
      task({ taskKey: 'c', title: 'Changed' }),
      task({ taskKey: 'd' })
    ]
    expect(diffObjectivePlans(previous, overBoundary).fullReviewRequired).toBe(true)
  })

  it('counts added, removed, and changed tasks together against the larger plan size', () => {
    const previous = [task({ taskKey: 'a' }), task({ taskKey: 'b' })]
    // removed 'b', added 'c': churn 2 of max(2,2)=2 -> 100%, over the boundary.
    const next = [task({ taskKey: 'a' }), task({ taskKey: 'c' })]

    const diff = diffObjectivePlans(previous, next)

    expect(diff.added).toEqual(['c'])
    expect(diff.removed).toEqual(['b'])
    expect(diff.fullReviewRequired).toBe(true)
  })
})
