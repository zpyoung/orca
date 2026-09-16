import { describe, expect, it } from 'vitest'
import {
  ImplementerReportSchema,
  IntegratorReportSchema,
  ObjectivePlanSchema,
  PlannerReportSchema,
  ReviewerReportSchema,
  objectivePathMatchesTerritory,
  parseAndValidateImplementerReport,
  parseAndValidatePlannerReport,
  parseAndValidateReviewerReport,
  type ObjectivePlanTask
} from './plan-schema'

function task(taskKey: string, overrides: Partial<ObjectivePlanTask> = {}): ObjectivePlanTask {
  return {
    taskKey,
    title: `Task ${taskKey}`,
    spec: `Implement ${taskKey}`,
    deps: [],
    criteria: [{ body: `${taskKey} works`, shellCheckable: true, checkCommand: 'pnpm check' }],
    declaresDependencyChange: false,
    ...overrides
  }
}

describe('objective plan schema', () => {
  it('accepts a bounded acyclic task graph', () => {
    const report = PlannerReportSchema.parse({
      plan: [task('core'), task('ui', { deps: ['core'], declaredPaths: ['src/ui.ts'] })]
    })
    expect(report.plan.map((item) => item.taskKey)).toEqual(['core', 'ui'])
  })

  it('rejects duplicate, unknown, self and cyclic dependencies', () => {
    const invalidPlans: ObjectivePlanTask[][] = [
      [task('same'), task('same')],
      [task('a', { deps: ['missing'] })],
      [task('a', { deps: ['a'] })],
      [task('a', { deps: ['b'] }), task('b', { deps: ['a'] })]
    ]
    for (const plan of invalidPlans) {
      expect(ObjectivePlanSchema.safeParse(plan).success).toBe(false)
    }
  })

  it('rejects malformed and missing acceptance criteria', () => {
    expect(ObjectivePlanSchema.safeParse([task('a', { criteria: [] })]).success).toBe(false)
    expect(
      ObjectivePlanSchema.safeParse([
        task('a', {
          criteria: [{ body: 'broken pair', shellCheckable: true, checkCommand: null }]
        })
      ]).success
    ).toBe(false)
  })

  it('enforces territory and preserves every previously dispatched task key', () => {
    expect(() =>
      parseAndValidatePlannerReport(
        { plan: [task('kept', { declaredPaths: ['src/a.ts'] })] },
        { writeTerritory: ['src/**'], dispatchedTaskKeys: ['kept'] }
      )
    ).not.toThrow()
    expect(() =>
      parseAndValidatePlannerReport(
        { plan: [task('kept', { declaredPaths: ['docs/a.txt'] })] },
        { writeTerritory: ['src/**'], dispatchedTaskKeys: ['kept'] }
      )
    ).toThrow('outside write territory')
    expect(() =>
      parseAndValidatePlannerReport(
        { plan: [task('replacement')] },
        { writeTerritory: ['src/**'], dispatchedTaskKeys: ['already-dispatched'] }
      )
    ).toThrow('cannot be removed')
  })
})

describe('objective write territory matching', () => {
  it('matches root and nested workspace paths without admitting protected state', () => {
    expect(objectivePathMatchesTerritory('README.md', ['**'])).toBe(true)
    expect(objectivePathMatchesTerritory('src/nested/file.ts', ['**'])).toBe(true)
    expect(objectivePathMatchesTerritory('.git/config', ['**'])).toBe(false)
    expect(objectivePathMatchesTerritory('.orca/runtime/state.json', ['**'])).toBe(false)
  })
})

describe('objective role report schemas', () => {
  it('requires implementer coverage and modified files inside territory', () => {
    const planned = task('core', {
      criteria: [
        { body: 'first', shellCheckable: false, checkCommand: null },
        { body: 'second', shellCheckable: true, checkCommand: 'pnpm check' }
      ]
    })
    expect(() =>
      parseAndValidateImplementerReport(
        {
          taskKey: 'core',
          summary: 'Implemented',
          filesModified: ['src/core.ts'],
          criteriaSelfAssessment: [
            { criterionIndex: 0, result: 'pass', note: 'Inspected' },
            { criterionIndex: 1, result: 'pass', note: 'Check passed' }
          ]
        },
        planned,
        ['src/**']
      )
    ).not.toThrow()
    expect(() =>
      parseAndValidateImplementerReport(
        {
          taskKey: 'core',
          summary: 'Incomplete',
          filesModified: ['docs/outside.md'],
          criteriaSelfAssessment: [{ criterionIndex: 0, result: 'unknown', note: 'Not checked' }]
        },
        planned,
        ['src/**']
      )
    ).toThrow()
  })

  it('rejects incomplete reviewer criterion coverage rather than treating omission as approval', () => {
    const plan = [
      task('core', {
        criteria: [
          { body: 'first', shellCheckable: false, checkCommand: null },
          { body: 'second', shellCheckable: false, checkCommand: null }
        ]
      })
    ]
    expect(() =>
      parseAndValidateReviewerReport(
        {
          verdict: 'approve',
          criteriaResults: [
            { taskKey: 'core', criterionIndex: 0, result: 'pass', note: 'Only one reviewed' }
          ],
          summary: 'Incomplete'
        },
        plan
      )
    ).toThrow('every plan criterion')
  })

  it('requires verdicts to agree with criterion results for reviewer and integrator reports', () => {
    const inconsistent = {
      verdict: 'approve',
      criteriaResults: [{ taskKey: 'core', criterionIndex: 0, result: 'block', note: 'Broken' }],
      summary: 'Blocked'
    }
    expect(ReviewerReportSchema.safeParse(inconsistent).success).toBe(false)
    expect(IntegratorReportSchema.safeParse({ ...inconsistent, checksRun: [] }).success).toBe(false)
  })

  it('keeps report objects strict and bounded', () => {
    expect(
      ImplementerReportSchema.safeParse({
        taskKey: 'core',
        summary: 'Done',
        filesModified: [],
        criteriaSelfAssessment: [],
        extra: true
      }).success
    ).toBe(false)
  })
})
