import type { PipelineTask } from '../task-list'

/** Orders child applications topologically, using task-list order for every tie. */
export function mergeOrder(
  tasks: readonly PipelineTask[],
  skipped: ReadonlySet<string> = new Set()
): string[] {
  const position = new Map(tasks.map((task, index) => [task.id, index]))
  const remaining = new Map(
    tasks.filter((task) => !skipped.has(task.id)).map((task) => [task.id, task])
  )
  const ordered: string[] = []
  const completed = new Set(skipped)

  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((task) => (task.deps ?? []).every((dependency) => completed.has(dependency)))
      .sort((left, right) => (position.get(left.id) ?? 0) - (position.get(right.id) ?? 0))
    const next = ready[0]
    if (next === undefined) {
      for (const task of remaining.values()) {
        ordered.push(task.id)
      }
      return ordered
    }
    remaining.delete(next.id)
    completed.add(next.id)
    ordered.push(next.id)
  }
  return ordered
}
