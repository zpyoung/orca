import { approvalScopeForAction } from '../../fork-heimdall/gate'
import { getLatestApproval, getLatestEscalations } from '../../fork-heimdall/ledger-queries'
import type { KernelAction, WatcherLedger } from '../../fork-heimdall/ledger-types'
import type { Deviation, PipelineNodeDeviation } from '../../fork-heimdall/owner/deviation'
import { ownerDeviationEscalationId } from '../../fork-heimdall/owner/deviation'
import type { PipelineNode } from '../document-schema'
import {
  parsePipelineNodeEvidenceKey,
  pipelineChoiceOptions,
  type PipelineChoice,
  type PipelineChoiceCause,
  type PipelineAnswerEvidence
} from '../choice-types'
import type { PipelineWorld, PipelineNodeRunState } from './index'
import { buildPipelineAction } from './action-envelope'
import type { Candidate, ChoiceRouting } from './decision-types'
import { boundedDetail, nodeForInstance, optionsForNode } from './decision-types'
import {
  actionHasLanded,
  actionIsInFlight,
  answerForAction,
  readPipelineAnswers
} from './choice-rules'
import { nodeIdFromInstanceId } from './node-instance'
import { mergeConflictProvenance } from './conflict-resolution'

export function buildChoiceAction(input: {
  world: PipelineWorld
  node: PipelineNode
  instanceId: string
  epoch: number
  attempt: number
  cause: PipelineChoiceCause
  options: readonly PipelineChoice[]
  deadlineMs?: number
  answer?: PipelineAnswerEvidence
  approvalRequired?: boolean
  detail: string
  fields?: Record<string, unknown>
}): KernelAction {
  return buildPipelineAction({
    kind: 'pipeline-apply-choice',
    capability: 'gate',
    visibility: 'local',
    pin: input.world.payload.pin,
    instanceId: input.instanceId,
    nodeId: input.node.id,
    epoch: input.epoch,
    attempt: input.attempt,
    cause: input.cause,
    ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
    fields: {
      cause: input.cause,
      options: [...input.options],
      approvalRequired: input.approvalRequired ?? true,
      detail: boundedDetail(input.detail),
      ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
      ...(input.answer === undefined
        ? {}
        : {
            choice: input.answer.choice,
            ...(input.answer.comment === undefined ? {} : { comment: input.answer.comment }),
            ...(input.answer.extendMinutes === undefined
              ? {}
              : { extendMinutes: input.answer.extendMinutes })
          }),
      ...input.fields
    }
  })
}

export function buildGateAction(
  world: PipelineWorld,
  node: Extract<PipelineNode, { type: 'gate' }>,
  instanceId: string,
  epoch: number,
  attempt: number
): KernelAction {
  const options = pipelineChoiceOptions({
    nodeType: node.type,
    cause: 'gate',
    ...(node.sendBackTo === undefined ? {} : { gateSendBackTo: node.sendBackTo })
  })
  return buildPipelineAction({
    kind: 'pipeline-pass-gate',
    capability: 'gate',
    visibility: 'local',
    pin: world.payload.pin,
    instanceId,
    nodeId: node.id,
    epoch,
    attempt,
    cause: 'gate',
    fields: {
      approvalRequired: true,
      cause: 'gate',
      options: [...options],
      label: node.label,
      notify: node.notify
    }
  })
}

function mergeConflictActionFields(
  ledger: WatcherLedger,
  world: PipelineWorld,
  node: PipelineNode,
  cause: PipelineChoiceCause
): Record<string, unknown> | undefined {
  if (cause !== 'merge-conflict' || node.type !== 'merge') {
    return undefined
  }
  let conflictRow: PipelineWorld['facts']['mergeProgress'][number] | null = null
  for (const row of world.facts.mergeProgress) {
    if (
      row.mergeId === node.id &&
      (row.state === 'conflict' || row.state === 'resolving') &&
      row.conflict !== null
    ) {
      conflictRow = row
    }
  }
  if (conflictRow === null || conflictRow.conflict === null) {
    return undefined
  }
  return {
    ...mergeConflictProvenance(ledger, node, conflictRow),
    conflictingChildInstanceId: conflictRow.childInstanceId,
    conflictingChildren: conflictRow.conflict.conflictingChildren,
    conflictPaths: conflictRow.conflict.paths
  }
}

function actionForAnswer(
  world: PipelineWorld,
  ledger: WatcherLedger,
  answer: PipelineAnswerEvidence
): KernelAction | null {
  const parsed = parsePipelineNodeEvidenceKey(answer.scope.evidenceKey)
  if (parsed === null) {
    return null
  }
  const node = nodeForInstance(world.payload.document, parsed.instanceId)
  if (node === undefined) {
    return null
  }
  if (answer.scope.actionKind === 'pipeline-pass-gate') {
    if (node.type !== 'gate' || parsed.cause !== 'gate') {
      return null
    }
    return buildGateAction(world, node, parsed.instanceId, parsed.epoch, parsed.attempt)
  }
  if (answer.scope.actionKind !== 'pipeline-apply-choice' || parsed.cause === undefined) {
    return null
  }
  const conflictFields = mergeConflictActionFields(ledger, world, node, parsed.cause)
  return buildChoiceAction({
    world,
    node,
    instanceId: parsed.instanceId,
    epoch: parsed.epoch,
    attempt: parsed.attempt,
    cause: parsed.cause,
    options: optionsForNode(node, parsed.instanceId, parsed.cause),
    ...(parsed.deadlineMs === undefined ? {} : { deadlineMs: parsed.deadlineMs }),
    ...(conflictFields === undefined ? {} : { fields: conflictFields }),
    answer,
    approvalRequired: answer.attribution.surface !== 'owner-agent',
    detail: answer.choice
  })
}

export function pendingAnswerCandidates(
  world: PipelineWorld,
  ledger: WatcherLedger,
  orderByNode: ReadonlyMap<string, number>
): Candidate[] {
  const candidates: Candidate[] = []
  for (const answer of readPipelineAnswers(ledger)) {
    const action = actionForAnswer(world, ledger, answer)
    if (
      action === null ||
      answerForAction(ledger, action) === null ||
      actionHasLanded(ledger, action) ||
      actionIsInFlight(ledger, action)
    ) {
      continue
    }
    const parsed = parsePipelineNodeEvidenceKey(answer.scope.evidenceKey)
    const order =
      parsed === null
        ? Number.MAX_SAFE_INTEGER
        : (orderByNode.get(nodeIdFromInstanceId(parsed.instanceId)) ?? 0)
    candidates.push({ stage: 0, order, action })
  }
  return candidates
}

export function ownerEscalationStatus(
  watcherId: string,
  ledger: WatcherLedger,
  deviation: Deviation
): 'new' | 'open' | 'acknowledged' | 'resolved' | 'escalated' {
  const id = ownerDeviationEscalationId(watcherId, deviation)
  return getLatestEscalations(ledger).find((entry) => entry.escalationId === id)?.status ?? 'new'
}

export function routeNodeChoice(input: {
  world: PipelineWorld
  ledger: WatcherLedger
  node: PipelineNode
  instanceId: string
  epoch: number
  attempt: number
  cause: PipelineChoiceCause
  options: readonly PipelineChoice[]
  deadlineMs?: number
  detail: string
  fields?: Record<string, unknown>
  order: number
}): ChoiceRouting {
  const deviation: PipelineNodeDeviation = {
    kind: 'pipeline-node',
    nodeInstanceId: input.instanceId,
    epoch: input.epoch,
    attempt: input.attempt,
    ...(input.cause === 'time-limit' && input.deadlineMs !== undefined
      ? { deadlineMs: input.deadlineMs }
      : {}),
    cause: input.cause,
    options: [...input.options],
    detail: boundedDetail(input.detail)
  }
  if (input.world.hasOwner) {
    const status = ownerEscalationStatus(input.world.watcherId, input.ledger, deviation)
    if (status === 'new') {
      return { deviation, blocked: true }
    }
    if (status === 'open' || status === 'acknowledged' || status === 'resolved') {
      return { blocked: true }
    }
    const action = buildChoiceAction({
      world: input.world,
      node: input.node,
      instanceId: input.instanceId,
      epoch: input.epoch,
      attempt: input.attempt,
      cause: input.cause,
      options: input.options,
      ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
      ...(input.fields === undefined ? {} : { fields: input.fields }),
      approvalRequired: true,
      detail: input.detail
    })
    if (actionHasLanded(input.ledger, action) || actionIsInFlight(input.ledger, action)) {
      return { blocked: true }
    }
    return {
      blocked: false,
      candidate: {
        stage: isApprovalCandidate(input.world, input.ledger, action) ? 3 : 0,
        order: input.order,
        action
      }
    }
  }
  const action = buildChoiceAction({
    world: input.world,
    node: input.node,
    instanceId: input.instanceId,
    epoch: input.epoch,
    attempt: input.attempt,
    cause: input.cause,
    options: input.options,
    ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
    ...(input.fields === undefined ? {} : { fields: input.fields }),
    approvalRequired: true,
    detail: input.detail
  })
  if (actionHasLanded(input.ledger, action) || actionIsInFlight(input.ledger, action)) {
    return { blocked: true }
  }
  return {
    blocked: false,
    candidate: {
      stage: isApprovalCandidate(input.world, input.ledger, action) ? 3 : 0,
      order: input.order,
      action
    }
  }
}

function hasCapabilityApproval(ledger: WatcherLedger, action: KernelAction): boolean {
  return getLatestApproval(ledger, approvalScopeForAction(action))?.decision === 'approved'
}

export function isApprovalCandidate(
  world: PipelineWorld,
  ledger: WatcherLedger,
  action: KernelAction
): boolean {
  const approvalRequired = action.approvalRequired === true
  const mode = world.grants[action.capability] ?? 'off'
  return (approvalRequired || mode !== 'on') && !hasCapabilityApproval(ledger, action)
}

export function addCandidate(
  candidates: Candidate[],
  world: PipelineWorld,
  ledger: WatcherLedger,
  action: KernelAction,
  stage: number,
  order: number
): void {
  candidates.push({ stage: isApprovalCandidate(world, ledger, action) ? 3 : stage, order, action })
}

export function configurationChoice(input: {
  world: PipelineWorld
  ledger: WatcherLedger
  node: PipelineNode
  state: PipelineNodeRunState
  order: number
  detail: string
}): ChoiceRouting {
  return routeNodeChoice({
    world: input.world,
    ledger: input.ledger,
    node: input.node,
    instanceId: input.node.id,
    epoch: input.state.epoch,
    attempt: input.state.attempt,
    cause: 'configuration',
    options: pipelineChoiceOptions({ nodeType: input.node.type, cause: 'configuration' }),
    detail: input.detail,
    order: input.order
  })
}
