import { describe, expect, it } from 'vitest'
import { parseAndValidatePlannerRepairReport } from './plan-repair-schema'
import type { ObjectivePlanTask } from './plan-schema'

const CONTRACT = { writeTerritory: ['src/**'] }

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

describe('parseAndValidatePlannerRepairReport', () => {
  it('rejects a malformed report with the schema failure', () => {
    expect(() => parseAndValidatePlannerRepairReport({}, CONTRACT, [task('a')])).toThrow()
  })

  it('rejects an empty patch', () => {
    expect(() =>
      parseAndValidatePlannerRepairReport(
        { repair: { upsertTasks: [], dropTaskKeys: [] }, assumptions: [] },
        CONTRACT,
        [task('a')]
      )
    ).toThrow('Repair patch is empty')
  })

  it('rejects a key that is both upserted and dropped', () => {
    expect(() =>
      parseAndValidatePlannerRepairReport(
        {
          repair: {
            upsertTasks: [task('a', { territory: ['src/**'] })],
            dropTaskKeys: ['a']
          },
          assumptions: []
        },
        CONTRACT,
        [task('a')]
      )
    ).toThrow('Repair patch both upserts and drops a')
  })

  it('rejects dropping a task the current plan does not have', () => {
    expect(() =>
      parseAndValidatePlannerRepairReport(
        { repair: { upsertTasks: [], dropTaskKeys: ['missing'] }, assumptions: [] },
        CONTRACT,
        [task('a')]
      )
    ).toThrow('Repair patch drops unknown task missing')
  })

  it('rejects an upserted task that omits territory', () => {
    expect(() =>
      parseAndValidatePlannerRepairReport(
        { repair: { upsertTasks: [task('a')], dropTaskKeys: [] }, assumptions: [] },
        CONTRACT,
        [task('a')]
      )
    ).toThrow('Planner task a must declare territory')
  })

  it('rejects a declared path outside the objective write territory', () => {
    expect(() =>
      parseAndValidatePlannerRepairReport(
        {
          repair: {
            upsertTasks: [task('a', { territory: ['src/**'], declaredPaths: ['docs/outside.md'] })],
            dropTaskKeys: []
          },
          assumptions: []
        },
        CONTRACT,
        [task('a')]
      )
    ).toThrow('Task a declares path outside write territory: docs/outside.md')
  })

  it('rejects a patch whose resulting plan is invalid', () => {
    expect(() =>
      parseAndValidatePlannerRepairReport(
        {
          repair: {
            upsertTasks: [task('a', { territory: ['src/**'], deps: ['a'] })],
            dropTaskKeys: []
          },
          assumptions: []
        },
        CONTRACT,
        [task('a')]
      )
    ).toThrow('Repair patch produces an invalid plan:')
  })

  it('requires assumptions to be present, even when empty', () => {
    expect(() =>
      parseAndValidatePlannerRepairReport(
        { repair: { upsertTasks: [task('b', { territory: ['src/**'] })], dropTaskKeys: [] } },
        CONTRACT,
        [task('a')]
      )
    ).toThrow('Planner report must declare assumptions (use [] when none)')
  })

  it('rejects an assumption naming a task outside the resulting plan', () => {
    expect(() =>
      parseAndValidatePlannerRepairReport(
        {
          repair: { upsertTasks: [task('b', { territory: ['src/**'] })], dropTaskKeys: [] },
          assumptions: [{ claim: 'the flag is off', dependentTaskKeys: ['missing'] }]
        },
        CONTRACT,
        [task('a')]
      )
    ).toThrow('Assumption 0 names unknown task missing')
  })

  it('accepts a valid repair patch', () => {
    const report = parseAndValidatePlannerRepairReport(
      {
        repair: { upsertTasks: [task('b', { territory: ['src/**'] })], dropTaskKeys: [] },
        assumptions: [{ claim: 'no schema change is needed', dependentTaskKeys: ['b'] }]
      },
      CONTRACT,
      [task('a')]
    )
    expect(report.repair.upsertTasks.map((item) => item.taskKey)).toEqual(['b'])
  })
})
