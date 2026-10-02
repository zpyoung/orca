import type { WatcherLedger } from '../../fork-heimdall/ledger-types'
import type { Deviation } from '../../fork-heimdall/owner/deviation'
import type { PipelineDocument, PipelineMergeNode, PipelineSwarmNode } from '../document-schema'
import type { PipelineNodeRunState, PipelineRunState, PipelineWorld } from './index'
import type { PipelineHistoryState } from './state-history'
import type { Candidate } from './decision-types'
import { addCandidate } from './decision-choices'
import {
  buildPipelineMergeChildAction,
  mergeConflictInfo,
  mergeProgressFor
} from './decision-executors'
import { mergeConflictProvenance, mergeConflictResolution } from './conflict-resolution'
import { mergeOrder } from './merge-order'
import { nodeInstanceId } from './node-instance'
import { pipelineAttemptFacts } from './node-history'
import { addDeviation, latestSwarmExpansion, routeChoiceForNode } from './decision-routing'

function hasInFlightMergeChoice(ledger: WatcherLedger, mergeId: string): boolean {
  return pipelineAttemptFacts(ledger).some(
    (fact) =>
      fact.identity.instanceId === mergeId &&
      fact.entry.action.kind === 'pipeline-apply-choice' &&
      fact.entry.action.cause === 'merge-conflict' &&
      fact.entry.state !== 'settled'
  )
}

function addMergeConflictChoice(input: {
  world: PipelineWorld
  ledger: WatcherLedger
  node: PipelineMergeNode
  state: PipelineNodeRunState
  order: number
  detail: string
  conflictingChildInstanceId: string
  conflictingChildren: string[]
  conflictPaths: string[]
  provenance?: Record<string, unknown>
  candidates: Candidate[]
  deviations: { order: number; deviation: Deviation }[]
}): void {
  const route = routeChoiceForNode({
    world: input.world,
    ledger: input.ledger,
    node: input.node,
    instanceId: input.node.id,
    state: input.state,
    cause: 'merge-conflict',
    detail: input.detail,
    fields: {
      ...input.provenance,
      conflictingChildInstanceId: input.conflictingChildInstanceId,
      conflictingChildren: input.conflictingChildren,
      conflictPaths: input.conflictPaths
    },
    order: input.order
  })
  if (route.deviation !== undefined) {
    addDeviation(input.deviations, input.order, route.deviation)
  }
  if (route.candidate !== undefined) {
    input.candidates.push(route.candidate)
  }
}

export function addMergeCandidates(input: {
  world: PipelineWorld
  ledger: WatcherLedger
  document: PipelineDocument
  node: PipelineMergeNode
  state: PipelineNodeRunState
  runState: PipelineRunState
  history: PipelineHistoryState
  order: number
  candidates: Candidate[]
  deviations: { order: number; deviation: Deviation }[]
}): void {
  if (hasInFlightMergeChoice(input.ledger, input.node.id)) {
    return
  }
  const swarm = input.document.nodes.find(
    (candidate): candidate is PipelineSwarmNode =>
      candidate.type === 'swarm' && candidate.id === input.node.from
  )
  const expansion =
    swarm === undefined
      ? undefined
      : latestSwarmExpansion(
          input.world,
          input.node.from,
          input.history.epochs.get(input.node.from) ?? 0
        )
  const conflict = mergeConflictInfo(input.world, input.node, input.history.skipped)
  if (conflict !== null) {
    const resolution =
      swarm === undefined || expansion === undefined
        ? { status: 'failed' as const }
        : mergeConflictResolution({
            world: input.world,
            ledger: input.ledger,
            merge: input.node,
            swarm,
            row: conflict.row,
            state: input.state,
            runState: input.runState,
            tasks: expansion.tasks
          })
    if (resolution.status === 'start') {
      const conflictOrder =
        expansion?.tasks.findIndex(
          (task) => nodeInstanceId(input.node.from, task.id) === conflict.row.childInstanceId
        ) ?? 0
      addCandidate(
        input.candidates,
        input.world,
        input.ledger,
        resolution.action,
        2,
        input.order + conflictOrder / 100
      )
    } else if (resolution.status === 'failed') {
      addMergeConflictChoice({
        world: input.world,
        ledger: input.ledger,
        node: input.node,
        state: input.state,
        order: input.order,
        detail: conflict.detail,
        conflictingChildInstanceId: conflict.row.childInstanceId,
        conflictingChildren: conflict.conflictingChildren,
        conflictPaths: conflict.paths,
        provenance: mergeConflictProvenance(input.ledger, input.node, conflict.row),
        candidates: input.candidates,
        deviations: input.deviations
      })
    }
    return
  }
  if (swarm === undefined || expansion === undefined) {
    return
  }

  const skipped = new Set(
    expansion.tasks.flatMap((task) =>
      input.runState.nodes.get(nodeInstanceId(input.node.from, task.id))?.status === 'skipped'
        ? [task.id]
        : []
    )
  )
  const orderIds = mergeOrder(expansion.tasks, skipped)
  for (let childOrder = 0; childOrder < orderIds.length; childOrder += 1) {
    const taskId = orderIds[childOrder]
    if (taskId === undefined) {
      continue
    }
    const childInstanceId = nodeInstanceId(input.node.from, taskId)
    const progress = mergeProgressFor(input.world, input.node.id, childInstanceId)
    if (progress?.state === 'applied' || progress?.state === 'skipped') {
      continue
    }
    if (progress?.state === 'resolving') {
      continue
    }
    if (progress?.state === 'conflict') {
      const paths =
        progress.conflict?.paths ?? input.world.mergeSources?.[childInstanceId]?.unmergedPaths ?? []
      const conflictingChildren = progress.conflict?.conflictingChildren ?? []
      const otherChildren =
        conflictingChildren.length === 0 ? '' : ` with ${conflictingChildren.join(', ')}`
      addMergeConflictChoice({
        world: input.world,
        ledger: input.ledger,
        node: input.node,
        state: input.state,
        order: input.order,
        detail: `Merge conflict in ${childInstanceId}${otherChildren}: ${paths.join(', ')}`,
        conflictingChildInstanceId: childInstanceId,
        conflictingChildren,
        provenance: mergeConflictProvenance(input.ledger, input.node, progress),
        conflictPaths: paths,
        candidates: input.candidates,
        deviations: input.deviations
      })
      continue
    }
    if (progress?.state === 'resolved') {
      const resolution = mergeConflictResolution({
        world: input.world,
        ledger: input.ledger,
        merge: input.node,
        swarm,
        row: progress,
        state: input.state,
        runState: input.runState,
        tasks: expansion.tasks
      })
      if (resolution.status !== 'landed') {
        if (resolution.status === 'failed') {
          const paths =
            progress.conflict?.paths ??
            input.world.mergeSources?.[childInstanceId]?.unmergedPaths ??
            []
          const conflictingChildren = progress.conflict?.conflictingChildren ?? []
          const otherChildren =
            conflictingChildren.length === 0 ? '' : ` with ${conflictingChildren.join(', ')}`
          addMergeConflictChoice({
            world: input.world,
            ledger: input.ledger,
            node: input.node,
            state: input.state,
            order: input.order,
            detail: `Merge conflict in ${childInstanceId}${otherChildren}: ${paths.join(', ')}`,
            conflictingChildInstanceId: childInstanceId,
            conflictingChildren,
            conflictPaths: paths,
            provenance: mergeConflictProvenance(input.ledger, input.node, progress),
            candidates: input.candidates,
            deviations: input.deviations
          })
        }
        continue
      }
    }
    const source = input.world.mergeSources?.[childInstanceId]
    if (
      source === undefined ||
      source.applicableBaseCommit.length === 0 ||
      source.workspaceDigest.length === 0
    ) {
      continue
    }
    if (source.unmergedPaths.length > 0) {
      addMergeConflictChoice({
        world: input.world,
        ledger: input.ledger,
        node: input.node,
        state: input.state,
        order: input.order,
        detail: `Merge conflict in ${childInstanceId}: ${source.unmergedPaths.join(', ')}`,
        conflictingChildInstanceId: childInstanceId,
        conflictingChildren: [],
        conflictPaths: source.unmergedPaths,
        candidates: input.candidates,
        deviations: input.deviations
      })
      continue
    }
    const action = buildPipelineMergeChildAction({
      world: input.world,
      node: input.node,
      source,
      epoch: input.state.epoch,
      attempt: input.state.attempt,
      tasks: expansion.tasks,
      taskOrder: childOrder
    })
    addCandidate(
      input.candidates,
      input.world,
      input.ledger,
      action,
      0,
      input.order + childOrder / 100
    )
    break
  }
}
