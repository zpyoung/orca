import { z } from 'zod'

export const PIPELINE_TASK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u
export const TaskSchema = z
  .object({
    id: z.string().regex(PIPELINE_TASK_ID_PATTERN),
    title: z.string().max(200),
    spec: z.string().max(16_384),
    deps: z.array(z.string().regex(PIPELINE_TASK_ID_PATTERN)).optional(),
    territory: z.array(z.string()).optional()
  })
  .strict()
export const TaskListSchema = z.array(TaskSchema).min(1).max(20)
export type PipelineTask = z.infer<typeof TaskSchema>
export type TaskList = z.infer<typeof TaskListSchema>

export type TaskListLintError = {
  code: 'empty' | 'too-many' | 'invalid-task' | 'duplicate-id' | 'unknown-dep' | 'cycle'
  taskId?: string
  dependencyId?: string
}
export type TaskListWarning = {
  code: 'territory-overlap'
  taskIds: [string, string]
  paths: string[]
}
export type TaskListLintResult = { errors: TaskListLintError[]; warnings: TaskListWarning[] }

function getDependencyAncestors(
  taskId: string,
  byId: ReadonlyMap<string, PipelineTask>
): Set<string> {
  const ancestors = new Set<string>()
  const pending = [...(byId.get(taskId)?.deps ?? [])]
  while (pending.length > 0) {
    const dependencyId = pending.pop()
    if (dependencyId === undefined || ancestors.has(dependencyId)) {
      continue
    }
    ancestors.add(dependencyId)
    pending.push(...(byId.get(dependencyId)?.deps ?? []))
  }
  return ancestors
}

export function lintTaskList(tasks: readonly unknown[]): TaskListLintResult {
  const errors: TaskListLintError[] = []
  const warnings: TaskListWarning[] = []
  if (tasks.length === 0) {
    return { errors: [{ code: 'empty' }], warnings }
  }
  if (tasks.length > 20) {
    errors.push({ code: 'too-many' })
  }

  const parsedTasks: PipelineTask[] = []
  const ids = new Set<string>()
  const byId = new Map<string, PipelineTask>()
  for (const item of tasks) {
    const parsed = TaskSchema.safeParse(item)
    if (!parsed.success) {
      const taskId =
        item !== null && typeof item === 'object' && 'id' in item && typeof item.id === 'string'
          ? item.id
          : undefined
      errors.push({ code: 'invalid-task', ...(taskId ? { taskId } : {}) })
      continue
    }
    const task = parsed.data
    parsedTasks.push(task)
    if (ids.has(task.id)) {
      errors.push({ code: 'duplicate-id', taskId: task.id })
      continue
    }
    ids.add(task.id)
    byId.set(task.id, task)
  }

  for (const task of parsedTasks) {
    for (const dependencyId of task.deps ?? []) {
      if (!ids.has(dependencyId)) {
        errors.push({ code: 'unknown-dep', taskId: task.id, dependencyId })
      }
    }
  }

  const cycleMembers = new Set<string>()
  for (const task of parsedTasks) {
    const ancestors = getDependencyAncestors(task.id, byId)
    if (ancestors.has(task.id)) {
      cycleMembers.add(task.id)
    }
  }
  for (const taskId of cycleMembers) {
    errors.push({ code: 'cycle', taskId })
  }

  for (let leftIndex = 0; leftIndex < parsedTasks.length; leftIndex += 1) {
    const left = parsedTasks[leftIndex]
    if (!left || ids.has(left.id) === false) {
      continue
    }
    const leftAncestors = getDependencyAncestors(left.id, byId)
    for (let rightIndex = leftIndex + 1; rightIndex < parsedTasks.length; rightIndex += 1) {
      const right = parsedTasks[rightIndex]
      if (
        !right ||
        leftAncestors.has(right.id) ||
        getDependencyAncestors(right.id, byId).has(left.id)
      ) {
        continue
      }
      const leftTerritories = new Set(
        (left.territory ?? []).map((path) => (path.startsWith('./') ? path.slice(2) : path))
      )
      const paths = [
        ...new Set(
          (right.territory ?? []).map((path) => (path.startsWith('./') ? path.slice(2) : path))
        )
      ]
        .filter((path) => leftTerritories.has(path))
        .sort()
      if (paths.length > 0) {
        warnings.push({ code: 'territory-overlap', taskIds: [left.id, right.id], paths })
      }
    }
  }

  return { errors, warnings }
}
