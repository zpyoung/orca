import type { ObjectivePlan, ObjectivePlanTask } from './plan-schema'

export type TaskKey = string

export type ObjectivePlanDiff = {
  added: TaskKey[]
  removed: TaskKey[]
  changed: TaskKey[]
  unchanged: TaskKey[]
  affected: TaskKey[]
  fullReviewRequired: boolean
}

function sortedKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).sort()
}

/** Deep-sorts object keys so field order never masks or fabricates a content difference. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(sortedKeys(record).map((key) => [key, canonicalize(record[key])]))
  }
  return value
}

function canonicalTaskJson(task: ObjectivePlanTask): string {
  return JSON.stringify(canonicalize(task))
}

/** Maps each task key to the keys of the tasks that directly depend on it, within one plan. */
function dependentsIndex(plan: ObjectivePlan): Map<TaskKey, TaskKey[]> {
  const dependents = new Map<TaskKey, TaskKey[]>()
  for (const task of plan) {
    for (const dependency of task.deps) {
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), task.taskKey])
    }
  }
  return dependents
}

function transitiveDependents(
  seeds: Iterable<TaskKey>,
  dependents: Map<TaskKey, TaskKey[]>
): Set<TaskKey> {
  const result = new Set<TaskKey>()
  const queue = [...seeds]
  for (let index = 0; index < queue.length; index++) {
    const key = queue[index]
    for (const dependent of dependents.get(key) ?? []) {
      if (!result.has(dependent)) {
        result.add(dependent)
        queue.push(dependent)
      }
    }
  }
  return result
}

/**
 * Compares two revisions of the same plan by task key: which tasks are new, dropped, textually
 * changed (their canonical JSON differs) or untouched, and everything a changed or added task pulls
 * into review scope through `next`'s dependency graph, directly or transitively. `fullReviewRequired`
 * is the delta review's own fallback: a revision more than half rewritten gets a full review instead.
 */
export function diffObjectivePlans(
  previous: ObjectivePlan,
  next: ObjectivePlan
): ObjectivePlanDiff {
  const previousByKey = new Map(previous.map((task) => [task.taskKey, task]))
  const nextByKey = new Map(next.map((task) => [task.taskKey, task]))

  const added: TaskKey[] = []
  const changed: TaskKey[] = []
  const unchanged: TaskKey[] = []
  for (const task of next) {
    const before = previousByKey.get(task.taskKey)
    if (!before) {
      added.push(task.taskKey)
    } else if (canonicalTaskJson(before) !== canonicalTaskJson(task)) {
      changed.push(task.taskKey)
    } else {
      unchanged.push(task.taskKey)
    }
  }
  const removed = previous.map((task) => task.taskKey).filter((taskKey) => !nextByKey.has(taskKey))

  const dependents = dependentsIndex(next)
  const affectedSeeds = [...added, ...changed]
  const affectedSet = new Set([
    ...affectedSeeds,
    ...transitiveDependents(affectedSeeds, dependents)
  ])
  const affected = next.map((task) => task.taskKey).filter((taskKey) => affectedSet.has(taskKey))

  const churn = added.length + removed.length + changed.length
  const denominator = Math.max(previous.length, next.length)
  const fullReviewRequired = denominator > 0 && churn / denominator > 0.5

  return { added, removed, changed, unchanged, affected, fullReviewRequired }
}
