import type { WatcherLedger } from '../fork-heimdall/ledger-types'
import {
  objectiveAttemptDisposition,
  objectiveAttempts,
  type ObjectiveAttempt
} from './decision-context'
import type { ObjectiveNodeProjection, ObjectiveWorld } from './detail-types'
import type { ObjectiveAction } from './objective-actions'

export const OBJECTIVE_LANE_MAX_SESSION_NODES = 5

export type ObjectiveSchedulingNode = Pick<ObjectiveNodeProjection, 'taskKey' | 'deps' | 'state'>

export type ObjectiveLane = {
  /** The tasks this worker session may execute, in the planner's original order. */
  taskKeys: string[]
  /** Original-plan index of the first task, used as the stable scheduling tie-breaker. */
  planOrder: number
}

export type ObjectiveLaneOptions = {
  enabled?: boolean
  maxSessionNodes?: number
}

function normalizedSessionLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return OBJECTIVE_LANE_MAX_SESSION_NODES
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > OBJECTIVE_LANE_MAX_SESSION_NODES) {
    throw new Error(
      `Objective lane session limit must be between 1 and ${OBJECTIVE_LANE_MAX_SESSION_NODES}`
    )
  }
  return limit
}

/**
 * Derives maximal one-to-one dependency chains, split at the five-node session boundary. Input
 * order is the planner's order and is preserved both within lanes and as the lane tie-breaker.
 */
export function deriveObjectiveLanes(
  nodes: readonly ObjectiveSchedulingNode[],
  options: ObjectiveLaneOptions = {}
): ObjectiveLane[] {
  const maxSessionNodes = normalizedSessionLimit(options.maxSessionNodes)
  const planOrder = new Map(nodes.map((node, index) => [node.taskKey, index]))
  const byKey = new Map(nodes.map((node) => [node.taskKey, node]))
  const dependents = new Map<string, string[]>()
  for (const node of nodes) {
    for (const dependency of node.deps) {
      if (!byKey.has(dependency)) {
        continue
      }
      const children = dependents.get(dependency) ?? []
      children.push(node.taskKey)
      dependents.set(dependency, children)
    }
  }
  for (const children of dependents.values()) {
    children.sort((left, right) => (planOrder.get(left) ?? 0) - (planOrder.get(right) ?? 0))
  }

  if (options.enabled === false) {
    return nodes.map((node, index) => ({ taskKeys: [node.taskKey], planOrder: index }))
  }

  const visited = new Set<string>()
  const lanes: ObjectiveLane[] = []
  const appendChain = (firstTaskKey: string): void => {
    let currentTaskKey: string | undefined = firstTaskKey
    let taskKeys: string[] = []
    let firstPlanOrder = planOrder.get(firstTaskKey) ?? 0
    while (currentTaskKey !== undefined && !visited.has(currentTaskKey)) {
      visited.add(currentTaskKey)
      taskKeys.push(currentTaskKey)
      if (taskKeys.length === maxSessionNodes) {
        lanes.push({ taskKeys, planOrder: firstPlanOrder })
        taskKeys = []
      }
      const children = dependents.get(currentTaskKey) ?? []
      const nextTaskKey = children.length === 1 ? children[0] : undefined
      const next = nextTaskKey === undefined ? undefined : byKey.get(nextTaskKey)
      currentTaskKey = next?.deps.length === 1 ? nextTaskKey : undefined
      if (taskKeys.length === 0 && currentTaskKey !== undefined) {
        firstPlanOrder = planOrder.get(currentTaskKey) ?? firstPlanOrder
      }
    }
    if (taskKeys.length > 0) {
      lanes.push({ taskKeys, planOrder: firstPlanOrder })
    }
  }

  for (const node of nodes) {
    const parent = node.deps.length === 1 ? node.deps[0] : undefined
    if (parent !== undefined && (dependents.get(parent)?.length ?? 0) === 1) {
      continue
    }
    appendChain(node.taskKey)
  }
  // Invalid or partially projected graphs should still expose every task exactly once. Valid plans
  // never need this fallback, but it keeps the helper total for recovery and detail rendering.
  for (const node of nodes) {
    if (!visited.has(node.taskKey)) {
      appendChain(node.taskKey)
    }
  }
  return lanes.sort((left, right) => left.planOrder - right.planOrder)
}

export function objectiveLaneForTask(
  nodes: readonly ObjectiveSchedulingNode[],
  taskKey: string,
  options: ObjectiveLaneOptions = {}
): ObjectiveLane | null {
  return (
    deriveObjectiveLanes(nodes, options).find((lane) => lane.taskKeys.includes(taskKey)) ?? null
  )
}

/** Counts the longest not-yet-applied path starting at each task, including that task. */
export function objectiveRemainingChainLengths(
  nodes: readonly ObjectiveSchedulingNode[]
): ReadonlyMap<string, number> {
  const byKey = new Map(nodes.map((node) => [node.taskKey, node]))
  const dependents = new Map<string, string[]>()
  for (const node of nodes) {
    for (const dependency of node.deps) {
      if (!byKey.has(dependency)) {
        continue
      }
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), node.taskKey])
    }
  }
  const lengths = new Map<string, number>()
  const visiting = new Set<string>()
  const visit = (taskKey: string): number => {
    const known = lengths.get(taskKey)
    if (known !== undefined) {
      return known
    }
    if (visiting.has(taskKey)) {
      return 0
    }
    visiting.add(taskKey)
    const node = byKey.get(taskKey)
    const length =
      node === undefined || node.state === 'succeeded' || node.state === 'replanned'
        ? 0
        : 1 + Math.max(0, ...(dependents.get(taskKey) ?? []).map(visit))
    visiting.delete(taskKey)
    lengths.set(taskKey, length)
    return length
  }
  for (const node of nodes) {
    visit(node.taskKey)
  }
  return lengths
}

/** Ready tasks in critical-path order, breaking equal lengths by original plan order. */
export function prioritizeReadyObjectiveTaskKeys(
  nodes: readonly ObjectiveSchedulingNode[],
  unavailableTaskKeys: ReadonlySet<string> = new Set(),
  forcedReadyTaskKeys: ReadonlySet<string> = new Set(),
  criticalPathOrder = true
): string[] {
  const byKey = new Map(nodes.map((node) => [node.taskKey, node]))
  const ready = nodes.filter(
    (node) =>
      (forcedReadyTaskKeys.has(node.taskKey) ||
        node.state === 'pending' ||
        node.state === 'awaiting-approval') &&
      !unavailableTaskKeys.has(node.taskKey) &&
      node.deps.every((dependency) => byKey.get(dependency)?.state === 'succeeded')
  )
  if (!criticalPathOrder) {
    return ready.map((node) => node.taskKey)
  }
  const planOrder = new Map(nodes.map((node, index) => [node.taskKey, index]))
  const lengths = objectiveRemainingChainLengths(nodes)
  return ready
    .sort(
      (left, right) =>
        (lengths.get(right.taskKey) ?? 0) - (lengths.get(left.taskKey) ?? 0) ||
        (planOrder.get(left.taskKey) ?? 0) - (planOrder.get(right.taskKey) ?? 0)
    )
    .map((node) => node.taskKey)
}

export function objectivePausedDispatchRetry(
  dispatch: ObjectiveAttempt,
  contentIdentity: string
): Extract<ObjectiveAction, { kind: 'dispatch-node' }> | null {
  if (dispatch.action.kind !== 'dispatch-node') {
    return null
  }
  if (dispatch.attempt.reason !== 'objective-train-paused') {
    return null
  }
  return { ...dispatch.action, contentIdentity }
}
export function objectiveExclusiveRoleInFlight(
  attempts: readonly ObjectiveAttempt[],
  ledger: WatcherLedger
): boolean {
  return attempts.some(
    ({ action, attempt }) =>
      (action.kind === 'dispatch-planner' ||
        action.kind === 'dispatch-reviewer' ||
        action.kind === 'dispatch-integrator') &&
      (objectiveAttemptDisposition(attempt, ledger) === 'in-flight' ||
        objectiveAttemptDisposition(attempt, ledger) === 'indeterminate')
  )
}

export type ObjectiveParallelSlotState = {
  effectiveMaxConcurrency: number
  runningCount: number
  availableSlots: number
}

/**
 * Combines the durable projection with attempts appended since the snapshot was read. This makes
 * repeated decisions in one kernel fill cycle respect the cap without waiting for a store refresh.
 */
export function objectiveParallelSlotState(
  world: ObjectiveWorld,
  ledger: WatcherLedger,
  revisionId: string
): ObjectiveParallelSlotState {
  const effectiveMaxConcurrency = world.parallel?.effectiveMaxConcurrency ?? 1
  const projectedFingerprints = new Set(
    world.parallel?.dispatches
      .filter((dispatch) =>
        ['running', 'waiting-to-apply', 'applying', 'resolving-conflict'].includes(dispatch.state)
      )
      .map((dispatch) => dispatch.attemptFingerprint) ?? []
  )
  let appendedRunningCount = 0
  for (const candidate of objectiveAttempts(ledger)) {
    if (candidate.action.kind !== 'dispatch-node' || candidate.action.revisionId !== revisionId) {
      continue
    }
    const disposition = objectiveAttemptDisposition(candidate.attempt, ledger)
    if (
      !projectedFingerprints.has(candidate.attempt.fingerprint) &&
      (disposition === 'in-flight' || disposition === 'indeterminate')
    ) {
      appendedRunningCount += 1
    }
  }
  const runningCount = (world.parallel?.runningCount ?? 0) + appendedRunningCount
  return {
    effectiveMaxConcurrency,
    runningCount,
    availableSlots: Math.max(0, effectiveMaxConcurrency - runningCount)
  }
}
