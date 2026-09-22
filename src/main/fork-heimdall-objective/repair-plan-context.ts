import type { ObjectiveNodeState } from '../../shared/fork-heimdall-objective/detail-types'
import type { ObjectivePlanTask } from '../../shared/fork-heimdall-objective/plan-schema'

export type RepairFrozenTask = {
  taskKey: string
  title: string
  state: 'succeeded' | 'running'
  summary?: string
  filesModified?: string[]
  completedAtMs?: number
}

export type RepairPlanContext = {
  openTasks: ObjectivePlanTask[]
  frozenTasks: RepairFrozenTask[]
}

/**
 * Partitions a plan into the tasks a repair replan may still write (`openTasks`) and the tasks it
 * must treat as immutable history (`frozenTasks`), in plan order. A task is frozen exactly when its
 * key is in `frozenTaskKeys`; its dispatch report (when available) supplies the frozen summary.
 */
export function buildRepairPlanContext(args: {
  plan: readonly ObjectivePlanTask[]
  nodeStates: ReadonlyMap<string, ObjectiveNodeState>
  frozenTaskKeys: ReadonlySet<string>
  reports: ReadonlyMap<
    string,
    { summary: string; filesModified: readonly string[]; completedAtMs?: number }
  >
}): RepairPlanContext {
  const openTasks: ObjectivePlanTask[] = []
  const frozenTasks: RepairFrozenTask[] = []
  for (const task of args.plan) {
    if (!args.frozenTaskKeys.has(task.taskKey)) {
      openTasks.push(task)
      continue
    }
    const state = args.nodeStates.get(task.taskKey) === 'succeeded' ? 'succeeded' : 'running'
    const report = args.reports.get(task.taskKey)
    frozenTasks.push({
      taskKey: task.taskKey,
      title: task.title,
      state,
      ...(report?.summary === undefined ? {} : { summary: report.summary }),
      ...(report?.filesModified === undefined ? {} : { filesModified: [...report.filesModified] }),
      ...(report?.completedAtMs === undefined ? {} : { completedAtMs: report.completedAtMs })
    })
  }
  return { openTasks, frozenTasks }
}

const REPAIR_SPEC_OMITTED_TEXT = '(spec omitted to fit prompt budget)'

function completedAtRank(task: RepairFrozenTask): number {
  return task.completedAtMs ?? Number.NEGATIVE_INFINITY
}

/**
 * Trims a repair context to fit `maxBytes` of its rendered form, oldest-first: first the summary and
 * filesModified of succeeded frozen tasks, then those entries down to their key alone, then the spec
 * text of open tasks in plan order. Returns whatever it could cut; the caller still enforces the hard
 * prompt-size limit, matching how an over-budget prompt is rejected today.
 */
export function fitRepairPlanContext(
  context: RepairPlanContext,
  maxBytes: number,
  render: (context: RepairPlanContext) => string
): { context: RepairPlanContext; omitted: string[] } {
  const fits = (candidate: RepairPlanContext): boolean =>
    Buffer.byteLength(render(candidate), 'utf8') <= maxBytes

  let working = context
  if (fits(working)) {
    return { context: working, omitted: [] }
  }

  const omitted: string[] = []
  const succeededOldestFirst = [...working.frozenTasks]
    .filter((task) => task.state === 'succeeded')
    .sort((a, b) => completedAtRank(a) - completedAtRank(b))
    .map((task) => task.taskKey)

  for (const taskKey of succeededOldestFirst) {
    if (fits(working)) {
      break
    }
    const task = working.frozenTasks.find((entry) => entry.taskKey === taskKey)
    if (!task || (task.summary === undefined && task.filesModified === undefined)) {
      continue
    }
    const { summary: _summary, filesModified: _filesModified, ...rest } = task
    working = {
      ...working,
      frozenTasks: working.frozenTasks.map((entry) => (entry.taskKey === taskKey ? rest : entry))
    }
    omitted.push(`${taskKey} summary/filesModified`)
  }

  for (const taskKey of succeededOldestFirst) {
    if (fits(working)) {
      break
    }
    if (!working.frozenTasks.some((entry) => entry.taskKey === taskKey)) {
      continue
    }
    working = {
      ...working,
      frozenTasks: working.frozenTasks.filter((entry) => entry.taskKey !== taskKey)
    }
    omitted.push(`${taskKey} frozen details (key only)`)
  }

  for (const task of working.openTasks) {
    if (fits(working)) {
      break
    }
    if (task.spec === REPAIR_SPEC_OMITTED_TEXT) {
      continue
    }
    working = {
      ...working,
      openTasks: working.openTasks.map((entry) =>
        entry.taskKey === task.taskKey ? { ...entry, spec: REPAIR_SPEC_OMITTED_TEXT } : entry
      )
    }
    omitted.push(`${task.taskKey} spec`)
  }

  return { context: working, omitted }
}
