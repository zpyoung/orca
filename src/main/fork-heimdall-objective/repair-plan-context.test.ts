import { describe, expect, it } from 'vitest'
import type { ObjectiveNodeState } from '../../shared/fork-heimdall-objective/detail-types'
import type { ObjectivePlanTask } from '../../shared/fork-heimdall-objective/plan-schema'
import {
  buildRepairPlanContext,
  fitRepairPlanContext,
  type RepairPlanContext
} from './repair-plan-context'

function task(taskKey: string, spec = `Implement ${taskKey}`): ObjectivePlanTask {
  return {
    taskKey,
    title: `Task ${taskKey}`,
    spec,
    deps: [],
    criteria: [{ body: `${taskKey} works`, shellCheckable: false, checkCommand: null }],
    declaresDependencyChange: false,
    territory: [`src/${taskKey}.ts`]
  }
}

describe('buildRepairPlanContext', () => {
  it('partitions frozen tasks from open tasks, preserving plan order', () => {
    const plan = [task('a'), task('b'), task('c')]
    const context = buildRepairPlanContext({
      plan,
      nodeStates: new Map<string, ObjectiveNodeState>([
        ['a', 'succeeded'],
        ['b', 'dispatched']
      ]),
      frozenTaskKeys: new Set(['a', 'b']),
      reports: new Map()
    })

    expect(context.openTasks.map((entry) => entry.taskKey)).toEqual(['c'])
    expect(context.frozenTasks.map((entry) => entry.taskKey)).toEqual(['a', 'b'])
  })

  it('marks a frozen task succeeded only when its node state is succeeded, else running', () => {
    const plan = [task('a'), task('b'), task('c')]
    const context = buildRepairPlanContext({
      plan,
      nodeStates: new Map<string, ObjectiveNodeState>([
        ['a', 'succeeded'],
        ['b', 'dispatched'],
        ['c', 'blocked-by-deps']
      ]),
      frozenTaskKeys: new Set(['a', 'b', 'c']),
      reports: new Map()
    })

    expect(context.frozenTasks).toEqual([
      { taskKey: 'a', title: 'Task a', state: 'succeeded' },
      { taskKey: 'b', title: 'Task b', state: 'running' },
      { taskKey: 'c', title: 'Task c', state: 'running' }
    ])
  })

  it('carries the dispatch report summary, filesModified, and completedAtMs when present', () => {
    const plan = [task('a')]
    const context = buildRepairPlanContext({
      plan,
      nodeStates: new Map<string, ObjectiveNodeState>([['a', 'succeeded']]),
      frozenTaskKeys: new Set(['a']),
      reports: new Map([
        ['a', { summary: 'Did the work.', filesModified: ['src/a.ts'], completedAtMs: 123 }]
      ])
    })

    expect(context.frozenTasks).toEqual([
      {
        taskKey: 'a',
        title: 'Task a',
        state: 'succeeded',
        summary: 'Did the work.',
        filesModified: ['src/a.ts'],
        completedAtMs: 123
      }
    ])
  })

  it('treats every task not named in frozenTaskKeys as open, regardless of state', () => {
    const plan = [task('a'), task('b')]
    const context = buildRepairPlanContext({
      plan,
      nodeStates: new Map<string, ObjectiveNodeState>([
        ['a', 'succeeded'],
        ['b', 'failed']
      ]),
      frozenTaskKeys: new Set(),
      reports: new Map()
    })

    expect(context.openTasks.map((entry) => entry.taskKey)).toEqual(['a', 'b'])
    expect(context.frozenTasks).toEqual([])
  })
})

function render(context: RepairPlanContext): string {
  return JSON.stringify(context)
}

/** Renders only the fields the fit rule trims, so test budgets are easy to reason about exactly. */
function compactRender(context: RepairPlanContext): string {
  const open = context.openTasks.map((entry) => `${entry.taskKey}:${entry.spec}`).join('|')
  const frozen = context.frozenTasks
    .map(
      (entry) =>
        `${entry.taskKey}:${entry.state}:${entry.summary ?? ''}:${(entry.filesModified ?? []).join(',')}`
    )
    .join('|')
  return `${open}##${frozen}`
}

describe('fitRepairPlanContext', () => {
  it('returns the context unchanged and no omissions when it already fits', () => {
    const context: RepairPlanContext = {
      openTasks: [task('a')],
      frozenTasks: [{ taskKey: 'b', title: 'Task b', state: 'succeeded', summary: 'done' }]
    }
    const result = fitRepairPlanContext(context, 10_000, render)
    expect(result).toEqual({ context, omitted: [] })
  })

  it('drops succeeded summary/filesModified before anything else, oldest completedAtMs first', () => {
    const context: RepairPlanContext = {
      openTasks: [],
      frozenTasks: [
        {
          taskKey: 'newer',
          title: 'Newer',
          state: 'succeeded',
          summary: 'x'.repeat(200),
          filesModified: ['src/newer.ts'],
          completedAtMs: 200
        },
        {
          taskKey: 'older',
          title: 'Older',
          state: 'succeeded',
          summary: 'y'.repeat(200),
          filesModified: ['src/older.ts'],
          completedAtMs: 100
        }
      ]
    }
    // budget only fits after stripping exactly one summary/filesModified pair
    const budget = Buffer.byteLength(render(context), 'utf8') - 50
    const result = fitRepairPlanContext(context, budget, render)

    expect(result.omitted).toEqual(['older summary/filesModified'])
    const older = result.context.frozenTasks.find((entry) => entry.taskKey === 'older')
    const newer = result.context.frozenTasks.find((entry) => entry.taskKey === 'newer')
    expect(older).toEqual({
      taskKey: 'older',
      title: 'Older',
      state: 'succeeded',
      completedAtMs: 100
    })
    expect(newer?.summary).toBe('x'.repeat(200))
  })

  it('treats a missing completedAtMs as oldest', () => {
    const context: RepairPlanContext = {
      openTasks: [],
      frozenTasks: [
        {
          taskKey: 'timestamped',
          title: 'Timestamped',
          state: 'succeeded',
          summary: 'x'.repeat(200),
          completedAtMs: 1
        },
        {
          taskKey: 'undated',
          title: 'Undated',
          state: 'succeeded',
          summary: 'y'.repeat(200)
        }
      ]
    }
    const budget = Buffer.byteLength(render(context), 'utf8') - 50
    const result = fitRepairPlanContext(context, budget, render)

    expect(result.omitted).toEqual(['undated summary/filesModified'])
  })

  it('reduces succeeded entries to key-only once stripping summaries is not enough', () => {
    const context: RepairPlanContext = {
      openTasks: [],
      frozenTasks: [
        {
          taskKey: 'only-succeeded',
          title: 'Only succeeded task with a long title '.repeat(5),
          state: 'succeeded',
          summary: 'z'.repeat(50)
        }
      ]
    }
    // smaller than even the stripped-summary form, so the entry must go key-only
    const budget = 40
    const result = fitRepairPlanContext(context, budget, render)

    expect(result.omitted).toEqual([
      'only-succeeded summary/filesModified',
      'only-succeeded frozen details (key only)'
    ])
    expect(result.context.frozenTasks).toEqual([])
  })

  it('never drops a running frozen task to key-only', () => {
    const context: RepairPlanContext = {
      openTasks: [],
      frozenTasks: [
        { taskKey: 'running-task', title: 'Running task '.repeat(10), state: 'running' }
      ]
    }
    const result = fitRepairPlanContext(context, 10, render)

    expect(result.context.frozenTasks).toEqual(context.frozenTasks)
    expect(result.omitted).toEqual([])
  })

  it('only drops open task spec text after exhausting frozen-task reductions, oldest plan order first', () => {
    const context: RepairPlanContext = {
      openTasks: [task('first', 'a'.repeat(100)), task('second', 'b'.repeat(100))],
      frozenTasks: [
        {
          taskKey: 'frozen',
          title: 'Frozen',
          state: 'succeeded',
          summary: 'c'.repeat(100)
        }
      ]
    }
    // fits only once the frozen entry is gone and "first"'s spec is replaced, not "second"'s
    const budget = 180
    const result = fitRepairPlanContext(context, budget, compactRender)

    expect(result.omitted).toEqual([
      'frozen summary/filesModified',
      'frozen frozen details (key only)',
      'first spec'
    ])
    expect(result.context.openTasks[0].spec).toBe('(spec omitted to fit prompt budget)')
    expect(result.context.openTasks[1].spec).toBe('b'.repeat(100))
  })

  it('cuts every open task spec when trimming frozen tasks alone does not fit', () => {
    const context: RepairPlanContext = {
      openTasks: [task('first', 'a'.repeat(50)), task('second', 'b'.repeat(50))],
      frozenTasks: []
    }
    // fits only once both specs are replaced
    const result = fitRepairPlanContext(context, 90, compactRender)

    expect(result.omitted).toEqual(['first spec', 'second spec'])
    expect(result.context.openTasks.every((entry) => entry.spec.startsWith('(spec omitted'))).toBe(
      true
    )
  })

  it('returns the best-effort context, still over budget, when nothing more can be cut', () => {
    const context: RepairPlanContext = {
      openTasks: [task('a', 'x')],
      frozenTasks: []
    }
    const result = fitRepairPlanContext(context, 1, render)

    expect(Buffer.byteLength(render(result.context), 'utf8')).toBeGreaterThan(1)
    expect(result.omitted).toEqual(['a spec'])
  })
})
