import { describe, expect, it } from 'vitest'
import {
  OBJECTIVE_DISPATCH_TASK_SNAPSHOT_MAX_BYTES,
  OBJECTIVE_TASK_SPEC_MAX_LENGTH
} from './contract-types'
import { parseAndValidatePlannerRepairReport } from './plan-repair-schema'
import { checkableTask as task } from './decision-test-harness'

const CONTRACT = { writeTerritory: ['src/**'] }

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

  it('rejects an upserted task whose dispatch snapshot exceeds the byte cap', () => {
    expect(() =>
      parseAndValidatePlannerRepairReport(
        {
          repair: {
            upsertTasks: [
              task('too-big', {
                territory: ['src/**'],
                spec: 's'.repeat(OBJECTIVE_TASK_SPEC_MAX_LENGTH)
              })
            ],
            dropTaskKeys: []
          },
          assumptions: []
        },
        CONTRACT,
        [task('a')]
      )
    ).toThrow(
      new RegExp(
        `Task too-big dispatch snapshot is \\d+ bytes, exceeding the ${OBJECTIVE_DISPATCH_TASK_SNAPSHOT_MAX_BYTES}-byte limit`
      )
    )
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
