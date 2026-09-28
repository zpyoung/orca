import { describe, expect, it } from 'vitest'
import type { ObjectiveGate } from '../../shared/fork-heimdall-objective/contract-types'
import { buildPlannerPromptPolicySection } from './planner-prompt-policy'

describe('buildPlannerPromptPolicySection', () => {
  it('states the shaping rules in C11 order, with the concurrency cap and lanes line', () => {
    const section = buildPlannerPromptPolicySection({
      effectiveMaxConcurrency: 4,
      lanesEnabled: true,
      gates: undefined
    })

    expect(section.startsWith('PLAN SHAPING POLICY:\n')).toBe(true)
    const expectedOrder = [
      'Size each node',
      'Tests ship together with the code',
      'Up to 4 nodes run at once.',
      'A node starts only once every dependency is applied',
      'One-to-one dependency chains share one warm session.',
      'A fresh session spends about 30% of a node orienting.',
      'Node checks must be scoped',
      'Node checks judge file contents',
      'OBJECTIVE GATES: none declared',
      'Objective gates run the full suite',
      'Every task must declare territory',
      'Declare assumptions naming the task keys'
    ]
    let cursor = -1
    for (const fragment of expectedOrder) {
      const index = section.indexOf(fragment)
      expect(index).toBeGreaterThan(cursor)
      cursor = index
    }
  })

  it('says checks judge file contents or scoped tests, never commit ranges', () => {
    const section = buildPlannerPromptPolicySection({
      effectiveMaxConcurrency: 1,
      lanesEnabled: false,
      gates: undefined
    })

    expect(section).toContain(
      'Node checks judge file contents or run scoped tests, never commit ranges'
    )
  })

  it('tells the planner to record evidence on assumptions it verified itself', () => {
    const section = buildPlannerPromptPolicySection({
      effectiveMaxConcurrency: 1,
      lanesEnabled: false,
      gates: undefined
    })

    expect(section).toContain(
      'Declare assumptions naming the task keys that depend on each one, with evidence on the ones you verified yourself.'
    )
  })

  it('omits the lanes line when lanesEnabled is false', () => {
    const section = buildPlannerPromptPolicySection({
      effectiveMaxConcurrency: 1,
      lanesEnabled: false,
      gates: undefined
    })

    expect(section).not.toContain('one warm session')
  })

  it('lists declared gate names, comma-separated', () => {
    const gates: ObjectiveGate[] = [
      { name: 'lint', command: 'oxlint .', timeoutSeconds: 60 },
      { name: 'typecheck', command: 'tsc', timeoutSeconds: 120 }
    ]
    const section = buildPlannerPromptPolicySection({
      effectiveMaxConcurrency: 2,
      lanesEnabled: true,
      gates
    })

    expect(section).toContain('OBJECTIVE GATES: lint, typecheck')
  })

  it('prints "none declared" when no gates exist', () => {
    const section = buildPlannerPromptPolicySection({
      effectiveMaxConcurrency: 1,
      lanesEnabled: true,
      gates: []
    })

    expect(section).toContain('OBJECTIVE GATES: none declared')
  })
})
