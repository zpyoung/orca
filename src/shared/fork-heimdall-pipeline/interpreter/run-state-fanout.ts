import type { PipelineDocument, PipelineSwarmNode } from '../document-schema'
import type { PipelineEnrollmentPayload } from '../enrollment-payload'
import type { PipelineStoreFacts } from '../store-facts'
import type { WatcherLedger } from '../../fork-heimdall/ledger-types'
import type { PipelineNodeRunState } from './index'
import type { PipelineAttemptFact } from './node-history'
import type { PipelineHistoryState } from './state-history'
import {
  pipelineNodeAttempt,
  pipelineNodeAttemptState,
  pipelineNodeEpoch,
  latestPipelineSwarmExpansion
} from './run-state-actions'
import { childTaskIdFromInstanceId, nodeInstanceId } from './node-instance'
import { readySwarmChildren } from './swarm-rules'

function mergeResolverObservation(input: {
  mergeId: string
  row: PipelineStoreFacts['mergeProgress'][number]
  state: PipelineNodeRunState
  attempts: readonly PipelineAttemptFact[]
  facts: PipelineStoreFacts
  unverifiableDispatchIds: ReadonlySet<string>
}): 'none' | 'running' | 'unverifiable' | 'failed' | 'landed' {
  const taskId = childTaskIdFromInstanceId(input.row.childInstanceId)
  if (taskId === null) {
    return 'none'
  }
  const instanceId = nodeInstanceId(input.mergeId, taskId)
  let latest: PipelineAttemptFact | null = null
  for (const fact of input.attempts) {
    if (
      fact.entry.action.kind === 'pipeline-resolve-merge-conflict' &&
      fact.identity.instanceId === instanceId &&
      fact.identity.nodeId === input.mergeId &&
      fact.identity.epoch === input.state.epoch &&
      fact.identity.attempt === input.state.attempt &&
      fact.entry.action.mergeId === input.mergeId &&
      fact.entry.action.childInstanceId === input.row.childInstanceId &&
      (latest === null || fact.entry.atMs > latest.entry.atMs)
    ) {
      latest = fact
    }
  }
  if (latest === null) {
    return input.row.state === 'resolving'
      ? 'running'
      : input.row.state === 'resolved'
        ? 'failed'
        : 'none'
  }
  if (latest.entry.state !== 'settled') {
    let dispatchId = latest.entry.dispatchId
    let dispatchedAtMs = -1
    for (const dispatch of input.facts.dispatches) {
      if (
        dispatch.instanceId === instanceId &&
        dispatch.epoch === input.state.epoch &&
        dispatch.attempt === input.state.attempt &&
        dispatch.dispatchedAtMs >= dispatchedAtMs
      ) {
        dispatchId = dispatch.dispatchId
        dispatchedAtMs = dispatch.dispatchedAtMs
      }
    }
    return dispatchId !== undefined && input.unverifiableDispatchIds.has(dispatchId)
      ? 'unverifiable'
      : 'running'
  }
  if (latest.effect !== 'landed') {
    return 'failed'
  }
  return input.row.state === 'resolved' ? 'landed' : 'running'
}

export function applySwarmChildStates(input: {
  document: PipelineDocument
  states: Map<string, PipelineNodeRunState>
  history: PipelineHistoryState
  attempts: readonly PipelineAttemptFact[]
  payload: PipelineEnrollmentPayload
  facts: PipelineStoreFacts
  ledger: WatcherLedger
  unverifiableDispatchIds: ReadonlySet<string>
}): void {
  for (const node of input.document.nodes) {
    if (node.type !== 'swarm') {
      continue
    }
    const epoch = pipelineNodeEpoch(input.history, node.id)
    const expansion = latestPipelineSwarmExpansion(input.facts, node.id, epoch)
    if (expansion === undefined) {
      continue
    }
    for (const task of expansion.tasks) {
      const instanceId = nodeInstanceId(node.id, task.id)
      const state = pipelineNodeAttemptState({
        node,
        instanceId,
        epoch,
        attempt: pipelineNodeAttempt(input.history, instanceId),
        attempts: input.attempts,
        payload: input.payload,
        facts: input.facts,
        ledger: input.ledger,
        unverifiableDispatchIds: input.unverifiableDispatchIds
      })
      input.states.set(
        instanceId,
        input.history.skipped.has(instanceId) ? { ...state, status: 'skipped' } : state
      )
    }
    let changed = true
    while (changed) {
      changed = false
      for (const task of expansion.tasks) {
        const instanceId = nodeInstanceId(node.id, task.id)
        const state = input.states.get(instanceId)
        if (state?.status !== 'pending' && state?.status !== 'ready') {
          continue
        }
        if (
          (task.deps ?? []).some(
            (dependency) =>
              input.states.get(nodeInstanceId(node.id, dependency))?.status === 'skipped'
          )
        ) {
          input.states.set(instanceId, { ...state, status: 'skipped' })
          changed = true
        } else if (
          state.status !== 'ready' &&
          (task.deps ?? []).every(
            (dependency) => input.states.get(nodeInstanceId(node.id, dependency))?.status === 'done'
          )
        ) {
          input.states.set(instanceId, { ...state, status: 'ready' })
          changed = true
        }
      }
    }
    const ready = new Set(
      readySwarmChildren({
        swarmId: node.id,
        tasks: expansion.tasks,
        states: input.states,
        maxParallel: node.maxParallel
      })
    )
    for (const task of expansion.tasks) {
      const instanceId = nodeInstanceId(node.id, task.id)
      const state = input.states.get(instanceId)
      if (state?.status === 'ready' && !ready.has(instanceId)) {
        input.states.set(instanceId, { ...state, status: 'pending' })
      }
    }
    const swarmState = input.states.get(node.id)
    if (swarmState !== undefined) {
      input.states.set(node.id, {
        ...swarmState,
        warnings: expansion.warnings,
        ...(expansion.tasks.every((task) => {
          const status = input.states.get(nodeInstanceId(node.id, task.id))?.status
          return status === 'done' || status === 'skipped'
        })
          ? { status: 'done' }
          : {})
      })
    }
  }
}

export function applyMergeStates(input: {
  document: PipelineDocument
  states: Map<string, PipelineNodeRunState>
  history: PipelineHistoryState
  facts: PipelineStoreFacts
  attempts: readonly PipelineAttemptFact[]
  unverifiableDispatchIds: ReadonlySet<string>
}): void {
  for (const node of input.document.nodes) {
    if (node.type !== 'merge') {
      continue
    }
    const swarm = input.document.nodes.find(
      (candidate): candidate is PipelineSwarmNode =>
        candidate.id === node.from && candidate.type === 'swarm'
    )
    const state = input.states.get(node.id)
    if (swarm === undefined || state === undefined) {
      continue
    }
    const epoch = pipelineNodeEpoch(input.history, node.from)
    const expansion = latestPipelineSwarmExpansion(input.facts, node.from, epoch)
    if (expansion === undefined) {
      continue
    }
    const childStates = expansion.tasks.map((task) =>
      input.states.get(nodeInstanceId(node.from, task.id))
    )
    if (
      childStates.some(
        (child) => child === undefined || (child.status !== 'done' && child.status !== 'skipped')
      )
    ) {
      continue
    }
    const progressByChild = new Map<string, PipelineStoreFacts['mergeProgress'][number]>()
    for (const row of input.facts.mergeProgress) {
      if (row.mergeId === node.id) {
        progressByChild.set(row.childInstanceId, row)
      }
    }
    const progress = [...progressByChild.values()]
    const allApplied = expansion.tasks.every((task) => {
      const childState = input.states.get(nodeInstanceId(node.from, task.id))
      const row = progress.find(
        (candidate) => candidate.childInstanceId === nodeInstanceId(node.from, task.id)
      )
      return (
        childState?.status === 'skipped' || row?.state === 'applied' || row?.state === 'skipped'
      )
    })
    const hasActiveConflict = progress.some(
      (row) => row.state === 'conflict' && !input.history.skipped.has(row.childInstanceId)
    )
    let hasResolverRunning = false
    let hasUnverifiableResolver = false
    let hasResolverFailure = false
    for (const row of progress) {
      if (
        (row.state !== 'conflict' && row.state !== 'resolving' && row.state !== 'resolved') ||
        input.history.skipped.has(row.childInstanceId)
      ) {
        continue
      }
      const observation = mergeResolverObservation({
        mergeId: node.id,
        row,
        state,
        attempts: input.attempts,
        facts: input.facts,
        unverifiableDispatchIds: input.unverifiableDispatchIds
      })
      if (observation === 'unverifiable') {
        hasUnverifiableResolver = true
      }
      if (observation === 'running') {
        hasResolverRunning = true
      }
      if (observation === 'failed') {
        hasResolverFailure = true
      }
    }
    if (hasUnverifiableResolver) {
      input.states.set(node.id, { ...state, status: 'unverifiable' })
    } else if (hasResolverRunning) {
      input.states.set(node.id, { ...state, status: 'running' })
    } else if (allApplied) {
      const mergedHead =
        progress.find((row) => row.state === 'applied')?.appliedCommitSha ?? undefined
      input.states.set(node.id, {
        ...state,
        status: 'done',
        outputs: mergedHead === undefined ? {} : { mergedHead }
      })
    } else if (hasActiveConflict || hasResolverFailure) {
      input.states.set(node.id, { ...state, status: 'waiting', waitingFor: 'choice' })
    } else {
      input.states.set(node.id, { ...state, status: 'ready' })
    }
  }
}
