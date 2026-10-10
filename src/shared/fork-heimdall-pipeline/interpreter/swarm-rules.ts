import type { PipelineNodeRunState } from './index'
import { nodeInstanceId } from './node-instance'
import type { TaskList } from '../task-list'

export type SwarmChildStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'unverifiable'

export function swarmChildInstances(swarmId: string, tasks: TaskList): string[] {
  return tasks.map((task) => nodeInstanceId(swarmId, task.id))
}

export function readySwarmChildren(input: {
  swarmId: string
  tasks: TaskList
  states: ReadonlyMap<string, PipelineNodeRunState>
  maxParallel: number
}): string[] {
  const activeCount = input.tasks.reduce((count, task) => {
    const child = input.states.get(nodeInstanceId(input.swarmId, task.id))
    return child?.status === 'running' || child?.status === 'unverifiable' ? count + 1 : count
  }, 0)
  const freeSlots = Math.max(0, input.maxParallel - activeCount)
  if (freeSlots === 0) {
    return []
  }
  const ready = input.tasks.filter((task) => {
    const childId = nodeInstanceId(input.swarmId, task.id)
    const state = input.states.get(childId)
    if (state?.status !== 'ready') {
      return false
    }
    return (task.deps ?? []).every(
      (dependencyId) =>
        input.states.get(nodeInstanceId(input.swarmId, dependencyId))?.status === 'done'
    )
  })
  return ready.slice(0, freeSlots).map((task) => nodeInstanceId(input.swarmId, task.id))
}
