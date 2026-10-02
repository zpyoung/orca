import type { OwnerInterventionRejection } from '../../shared/fork-heimdall/kind-contract'
import { z } from 'zod'
import { approvalScopeForAction } from '../../shared/fork-heimdall/gate'
import { getLatestApproval, getLatestEscalations } from '../../shared/fork-heimdall/ledger-queries'
import type {
  EscalationEntry,
  KernelAction,
  WatcherLedger
} from '../../shared/fork-heimdall/ledger-types'
import type { PipelineNodeDeviation } from '../../shared/fork-heimdall/owner/deviation'
import { ownerDeviationEscalationId } from '../../shared/fork-heimdall/owner/deviation'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import type {
  PipelineChoice,
  PipelineChoiceCause
} from '../../shared/fork-heimdall-pipeline/choice-types'
import {
  PipelineChoiceSchema,
  pipelineChoiceOptions
} from '../../shared/fork-heimdall-pipeline/choice-types'
import type { PipelineNode } from '../../shared/fork-heimdall-pipeline/document-schema'
import {
  decidePipelineNodeDeviation,
  mergeOrder,
  nodeIdFromInstanceId,
  nodeInstanceId
} from '../../shared/fork-heimdall-pipeline/interpreter'
import { buildChoiceAction } from '../../shared/fork-heimdall-pipeline/interpreter/decision-choices'
import { derivePipelineRunState } from '../../shared/fork-heimdall-pipeline/interpreter/run-state'
import type { PipelineStoreFacts } from '../../shared/fork-heimdall-pipeline/store-facts'
import {
  decodeOwnerDeviation,
  isOwnerDeviationEscalation
} from '../fork-heimdall/owner/deviation-ledger'
import {
  mergeRetryProvenanceFields,
  mergeRetryProvenanceMatches
} from './pipeline-owner-merge-retry'
import { isPipelineInvalidConfigurationWorld } from './pipeline-kind-read'
import type { PipelineKindWorld, PipelineReadyWorld } from './pipeline-kind-read'

const IdSchema = z.string().trim().min(1).max(1_024)

export const PipelineChoiceInterventionSchema = z
  .object({
    kind: z.literal('pipeline-choice'),
    escalationId: IdSchema,
    nodeInstanceId: IdSchema,
    choice: PipelineChoiceSchema,
    comment: z.string().trim().min(1).max(4_000).optional(),
    extendMinutes: z.number().int().min(1).max(1_440).optional()
  })
  .strict()

export type PipelineChoiceIntervention = z.infer<typeof PipelineChoiceInterventionSchema>
export type PipelineOwnerOpenDeviation = Readonly<{
  entry: EscalationEntry
  deviation: PipelineNodeDeviation
  node: PipelineNode
}>

type ReadyWorld = PipelineReadyWorld

function runState(world: ReadyWorld, ledger: WatcherLedger) {
  return derivePipelineRunState({
    payload: world.payload,
    ledger,
    facts: world.facts,
    nowMs: world.nowMs,
    hasOwner: world.hasOwner,
    unverifiableDispatchIds: world.unverifiableDispatchIds,
    composites: world.composites
  })
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function pipelineChoiceOptionsForNode(
  node: PipelineNode,
  cause: PipelineChoiceCause
): readonly PipelineChoice[] {
  return pipelineChoiceOptions({
    nodeType: node.type,
    cause,
    ...(node.type === 'gate' && node.sendBackTo !== undefined
      ? { gateSendBackTo: node.sendBackTo }
      : {}),
    ...('onFail' in node && node.onFail?.sendBackTo !== undefined
      ? { onFailSendBackTo: node.onFail.sendBackTo }
      : {})
  })
}

export function findCurrentOpenPipelineDeviation(
  world: ReadyWorld,
  ledger: WatcherLedger,
  escalationId: string,
  nodeInstanceId: string
): PipelineOwnerOpenDeviation | null {
  const derivationLedger = {
    ...ledger,
    entries: ledger.entries.filter(
      (entry) =>
        entry.kind !== 'escalation' ||
        !isOwnerDeviationEscalation(entry) ||
        entry.escalationId !== escalationId
    )
  }
  const selected = decidePipelineNodeDeviation(world, derivationLedger, nodeInstanceId)
  if (selected === null) {
    return null
  }
  const selectedId = ownerDeviationEscalationId(world.watcherId, selected)
  for (const entry of getLatestEscalations(ledger)) {
    if (
      entry.status !== 'open' ||
      !isOwnerDeviationEscalation(entry) ||
      entry.escalationId !== selectedId ||
      entry.escalationId !== escalationId
    ) {
      continue
    }
    const deviation = decodeOwnerDeviation(entry)
    if (
      deviation?.kind !== 'pipeline-node' ||
      entry.escalationId !== ownerDeviationEscalationId(world.watcherId, deviation) ||
      deviation.nodeInstanceId !== nodeInstanceId ||
      deviation.nodeInstanceId !== selected.nodeInstanceId ||
      deviation.epoch !== selected.epoch ||
      deviation.attempt !== selected.attempt ||
      deviation.cause !== selected.cause ||
      deviation.deadlineMs !== selected.deadlineMs ||
      deviation.detail !== selected.detail ||
      !sameStrings(deviation.options, selected.options)
    ) {
      continue
    }
    const nodeId = nodeIdFromInstanceId(deviation.nodeInstanceId)
    const node = world.payload.document.nodes.find((candidate) => candidate.id === nodeId)
    if (
      node === undefined ||
      !sameStrings(pipelineChoiceOptionsForNode(node, deviation.cause), deviation.options)
    ) {
      continue
    }
    if (deviation.cause === 'gate' && node.type !== 'gate') {
      continue
    }
    if (deviation.cause === 'merge-conflict' && node.type !== 'merge') {
      continue
    }
    if (
      (deviation.cause === 'loop-escalate' || deviation.cause === 'loop-max') &&
      node.type !== 'loop'
    ) {
      continue
    }
    if (deviation.cause === 'time-limit' && deviation.deadlineMs === undefined) {
      continue
    }
    return { entry, deviation, node }
  }
  return null
}

export function findCurrentOpenPipelineDeviationForNode(
  world: ReadyWorld,
  ledger: WatcherLedger,
  nodeInstanceId: string
): PipelineOwnerOpenDeviation | null {
  for (const entry of getLatestEscalations(ledger)) {
    if (entry.status !== 'open' || !isOwnerDeviationEscalation(entry)) {
      continue
    }
    const deviation = decodeOwnerDeviation(entry)
    if (deviation?.kind !== 'pipeline-node' || deviation.nodeInstanceId !== nodeInstanceId) {
      continue
    }
    const open = findCurrentOpenPipelineDeviation(world, ledger, entry.escalationId, nodeInstanceId)
    if (open !== null) {
      return open
    }
  }
  return null
}

function mergeConflictFields(
  world: ReadyWorld,
  deviation: PipelineNodeDeviation,
  ledger: WatcherLedger
): Record<string, unknown> | undefined {
  if (deviation.cause !== 'merge-conflict') {
    return undefined
  }
  let conflict: PipelineStoreFacts['mergeProgress'][number] | null = null
  for (const row of world.facts.mergeProgress) {
    if (
      row.mergeId === nodeIdFromInstanceId(deviation.nodeInstanceId) &&
      row.epoch === deviation.epoch &&
      (row.state === 'conflict' || row.state === 'resolving' || row.state === 'resolved') &&
      (conflict === null || row.childInstanceId >= conflict.childInstanceId)
    ) {
      conflict = row
    }
  }
  if (conflict !== null) {
    return {
      conflictingChildInstanceId: conflict.childInstanceId,
      ...(conflict.conflict === null
        ? {}
        : {
            conflictingChildren: conflict.conflict.conflictingChildren,
            conflictPaths: conflict.conflict.paths
          }),
      ...mergeRetryProvenanceFields(ledger, conflict)
    }
  }
  const merge = world.payload.document.nodes.find(
    (node): node is Extract<PipelineNode, { type: 'merge' }> =>
      node.id === nodeIdFromInstanceId(deviation.nodeInstanceId) && node.type === 'merge'
  )
  if (merge === undefined) {
    return undefined
  }
  const states = runState(world, ledger).nodes
  const expansion = world.facts.swarmExpansions.find(
    (row) => row.swarmId === merge.from && row.epoch === states.get(merge.from)?.epoch
  )
  if (expansion === undefined) {
    return undefined
  }
  const skipped = new Set(
    expansion.tasks.flatMap((task) =>
      states.get(nodeInstanceId(merge.from, task.id))?.status === 'skipped' ? [task.id] : []
    )
  )
  for (const taskId of mergeOrder(expansion.tasks, skipped)) {
    const childInstanceId = nodeInstanceId(merge.from, taskId)
    const source = world.mergeSources?.[childInstanceId]
    if (source !== undefined && source.unmergedPaths.length > 0) {
      return {
        conflictingChildInstanceId: childInstanceId,
        conflictingChildren: [],
        conflictPaths: source.unmergedPaths
      }
    }
  }
  return undefined
}

export function buildPipelineOwnerChoiceAction(
  world: ReadyWorld,
  deviation: PipelineNodeDeviation,
  node: PipelineNode,
  intervention: PipelineChoiceIntervention,
  ledger: WatcherLedger
): KernelAction {
  const fields = mergeConflictFields(world, deviation, ledger)
  const action = buildChoiceAction({
    world,
    node,
    instanceId: deviation.nodeInstanceId,
    epoch: deviation.epoch,
    attempt: deviation.attempt,
    cause: deviation.cause,
    options: deviation.options,
    ...(deviation.deadlineMs === undefined ? {} : { deadlineMs: deviation.deadlineMs }),
    ...(fields === undefined ? {} : { fields }),
    approvalRequired: false,
    detail: deviation.detail
  })
  return {
    ...action,
    choice: intervention.choice,
    ...(intervention.comment === undefined ? {} : { comment: intervention.comment }),
    ...(intervention.extendMinutes === undefined
      ? {}
      : { extendMinutes: intervention.extendMinutes }),
    ownerIntervention: true
  }
}

export function rejectPipelineOwnerChoice(
  intervention: PipelineChoiceIntervention,
  snapshot: Snapshot<PipelineKindWorld>,
  ledger: WatcherLedger,
  enrollment: WatcherEnrollment
): OwnerInterventionRejection | null {
  if (isPipelineInvalidConfigurationWorld(snapshot.world)) {
    return {
      gate: 'pipeline-choice',
      reason: 'Pipeline owner choices require a valid current configuration.'
    }
  }
  const world = snapshot.world
  if (
    enrollment.kind !== 'pipeline' ||
    !enrollment.enabled ||
    enrollment.paused ||
    !world.hasOwner ||
    world.watcherId !== enrollment.watcherId
  ) {
    return {
      gate: 'pipeline-choice',
      reason: 'Pipeline owner choices require the enabled current pipeline watcher.'
    }
  }
  const open = findCurrentOpenPipelineDeviation(
    world,
    ledger,
    intervention.escalationId,
    intervention.nodeInstanceId
  )
  if (open === null) {
    return {
      gate: 'pipeline-choice',
      reason: 'The selected pipeline-node deviation is not the exact current open owner choice.'
    }
  }
  if (
    open.deviation.cause === 'gate' ||
    open.node.type === 'gate' ||
    intervention.choice === 'approve'
  ) {
    return {
      gate: 'pipeline-choice',
      reason: 'Gate approvals are person-only and cannot be answered by an owner agent.'
    }
  }
  if (!open.deviation.options.includes(intervention.choice)) {
    return {
      gate: 'pipeline-choice',
      reason: `Choice ${intervention.choice} is not available for this open pipeline deviation.`
    }
  }
  if (intervention.choice === 'send-back' && intervention.comment === undefined) {
    return { gate: 'pipeline-choice', reason: 'A send-back choice requires a comment.' }
  }
  if (intervention.choice === 'extend' && intervention.extendMinutes === undefined) {
    return { gate: 'pipeline-choice', reason: 'An extend choice requires extendMinutes.' }
  }
  if (intervention.choice !== 'extend' && intervention.extendMinutes !== undefined) {
    return {
      gate: 'pipeline-choice',
      reason: 'extendMinutes is valid only with the extend choice.'
    }
  }
  const action = buildPipelineOwnerChoiceAction(
    world,
    open.deviation,
    open.node,
    intervention,
    ledger
  )
  if (intervention.choice === 'retry' && open.deviation.cause === 'merge-conflict') {
    if (typeof action.conflictingChildInstanceId !== 'string') {
      return {
        gate: 'pipeline-choice',
        reason: 'The Merge retry is missing its exact conflicting child.'
      }
    }
    const originalConflict = world.facts.mergeProgress.find(
      (row) =>
        row.mergeId === open.node.id &&
        row.epoch === open.deviation.epoch &&
        row.childInstanceId === action.conflictingChildInstanceId &&
        (row.state === 'conflict' || row.state === 'resolving' || row.state === 'resolved')
    )
    if (
      originalConflict === undefined ||
      !mergeRetryProvenanceMatches(action, ledger, originalConflict)
    ) {
      return {
        gate: 'pipeline-choice',
        reason: 'The Merge retry is missing its exact settled conflict provenance.'
      }
    }
  }
  if (getLatestApproval(ledger, approvalScopeForAction(action)) !== null) {
    return {
      gate: 'pipeline-choice',
      reason: 'An owner agent cannot consume a person or capability approval scope.'
    }
  }
  return null
}
