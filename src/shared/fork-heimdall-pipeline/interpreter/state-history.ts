import type { PipelineDocument, PipelineNode } from '../document-schema'
import type { KernelAction, WatcherLedger } from '../../fork-heimdall/ledger-types'
import { landedChoiceAttempts, pipelineAttemptFacts } from './node-history'
import { childTaskIdFromInstanceId, nodeIdFromInstanceId } from './node-instance'
import type { PipelineChoice } from '../choice-types'
import { loopReentryNode, loopRoundFacts } from './loop-rules'
import { pipelineOutputReference } from './decision-rules'

export type PipelineHistoryState = {
  epochs: Map<string, number>
  attempts: Map<string, number>
  failures: Map<string, number>
  skipped: Set<string>
  aborted: boolean
  gateOutputs: Map<string, Record<string, unknown>>
  /** Send-back comment per node, valid only for the epoch the send-back started. */
  sendBackComments: Map<string, { epoch: number; comment: string }>
  /** Loop epoch at which an operator accepted the loop. */
  acceptedLoops: Map<string, number>
  loopRounds: Map<string, number>
  loopExtraRounds: Map<string, number>
  oneMoreChoicesSeen: Map<string, number>
  /** Ledger position at which each node last moved to a new epoch. */
  epochAdvancedAt: Map<string, number>
  /** Ledger position of an instance's first attempt in an epoch, keyed by `epochKey`. */
  epochDispatchedAt: Map<string, number>
  /** Ledger position of the event being replayed; past the last entry once replay ends. */
  position: number
}

type HistoryEvent =
  | {
      atMs: number
      order: number
      kind: 'attempt'
      instanceId: string
      epoch: number
      attempt: number
      actionKind: string
      failed: boolean
      action: KernelAction
    }
  | {
      atMs: number
      order: number
      kind: 'choice'
      instanceId: string
      epoch: number
      attempt: number
      choice: PipelineChoice
      comment?: string
      extendMinutes?: number
      action: KernelAction
    }

function nodeById(document: PipelineDocument, instanceId: string): PipelineNode | undefined {
  const nodeId = nodeIdFromInstanceId(instanceId)
  return document.nodes.find((node) => node.id === nodeId)
}

function retryLimit(document: PipelineDocument, instanceId: string): number {
  const node = nodeById(document, instanceId)
  if (node?.type === 'swarm' && childTaskIdFromInstanceId(instanceId) !== null) {
    return node.child.retry ?? document.defaults?.retry ?? 0
  }
  if (node?.type === 'agent' || node?.type === 'check') {
    return node.retry ?? document.defaults?.retry ?? 0
  }
  return 0
}

function failureHasAutomaticRepair(document: PipelineDocument, instanceId: string): boolean {
  const node = nodeById(document, instanceId)
  return (node?.type === 'agent' || node?.type === 'check') && node.onFail?.sendBackTo !== undefined
}

function failureSendBackTarget(document: PipelineDocument, instanceId: string): string | undefined {
  const node = nodeById(document, instanceId)
  return node?.type === 'agent' || node?.type === 'check' ? node.onFail?.sendBackTo : undefined
}

function dependencySources(node: PipelineNode): string[] {
  return (node.after ?? []).map((edge) => (typeof edge === 'string' ? edge : edge.node))
}

function reaches(document: PipelineDocument, fromId: string, toId: string): boolean {
  if (fromId === toId) {
    return true
  }
  const visited = new Set<string>()
  const pending = [fromId]
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined || visited.has(current)) {
      continue
    }
    visited.add(current)
    for (const node of document.nodes) {
      if (dependencySources(node).includes(current)) {
        if (node.id === toId) {
          return true
        }
        pending.push(node.id)
      }
    }
  }
  return false
}

function pathNodes(document: PipelineDocument, fromId: string, toId: string): string[] {
  return document.nodes
    .filter((node) => reaches(document, fromId, node.id) && reaches(document, node.id, toId))
    .map((node) => node.id)
}

function epochKey(instanceId: string, epoch: number): string {
  return JSON.stringify([instanceId, epoch])
}

function advanceRepairPath(
  document: PipelineDocument,
  state: PipelineHistoryState,
  fromId: string,
  triggerId: string,
  triggerEpoch: number,
  preserveTriggerBudget: boolean,
  comment?: string
): void {
  // loop rounds advance only the body, so an earlier repair shows in dispatch order, not epoch size
  const triggerDispatchedAt =
    state.epochDispatchedAt.get(epochKey(triggerId, triggerEpoch)) ?? Number.POSITIVE_INFINITY
  for (const nodeId of pathNodes(document, fromId, triggerId)) {
    if ((state.epochAdvancedAt.get(nodeId) ?? -1) <= triggerDispatchedAt) {
      state.epochs.set(nodeId, Math.max(state.epochs.get(nodeId) ?? 0, triggerEpoch) + 1)
      state.epochAdvancedAt.set(nodeId, state.position)
      if (!(preserveTriggerBudget && nodeId === triggerId)) {
        state.attempts.set(nodeId, 0)
        state.failures.set(nodeId, 0)
      }
    }
    if (comment !== undefined && nodeId === fromId) {
      state.sendBackComments.set(nodeId, { epoch: state.epochs.get(nodeId) ?? 0, comment })
    }
  }
}

function startFromLedger(document: PipelineDocument, ledger: WatcherLedger): PipelineHistoryState {
  const loopRounds = new Map<string, number>()
  const loopExtraRounds = new Map<string, number>()
  for (const node of document.nodes) {
    if (node.type === 'loop') {
      const facts = loopRoundFacts(ledger, node.id)
      loopRounds.set(node.id, facts.round)
      loopExtraRounds.set(node.id, facts.extraRounds)
    }
  }
  const state: PipelineHistoryState = {
    epochs: new Map(document.nodes.map((node) => [node.id, 0])),
    attempts: new Map(document.nodes.map((node) => [node.id, 0])),
    failures: new Map(document.nodes.map((node) => [node.id, 0])),
    skipped: new Set(),
    aborted: false,
    gateOutputs: new Map(),
    sendBackComments: new Map(),
    acceptedLoops: new Map(),
    loopRounds,
    loopExtraRounds,
    oneMoreChoicesSeen: new Map(),
    epochAdvancedAt: new Map(),
    epochDispatchedAt: new Map(),
    position: -1
  }
  const attempts = pipelineAttemptFacts(ledger)
  const entryOrder = new Map(ledger.entries.map((entry, index) => [entry.eventId, index]))
  const firstEntryByAttempt = new Map<string, number>()
  ledger.entries.forEach((entry, index) => {
    if (entry.kind === 'attempt' && !firstEntryByAttempt.has(entry.attemptId)) {
      firstEntryByAttempt.set(entry.attemptId, index)
    }
  })
  const events: HistoryEvent[] = []

  for (const fact of attempts) {
    const key = epochKey(fact.identity.instanceId, fact.identity.epoch)
    const firstEntry = firstEntryByAttempt.get(fact.entry.attemptId) ?? 0
    state.epochDispatchedAt.set(
      key,
      Math.min(state.epochDispatchedAt.get(key) ?? firstEntry, firstEntry)
    )
    events.push({
      atMs: fact.entry.atMs,
      order: entryOrder.get(fact.entry.eventId) ?? 0,
      kind: 'attempt',
      instanceId: fact.identity.instanceId,
      epoch: fact.identity.epoch,
      attempt: fact.identity.attempt,
      actionKind: fact.entry.action.kind,
      failed:
        fact.entry.state === 'settled' &&
        fact.effect === 'not-landed' &&
        fact.entry.action.kind !== 'pipeline-pass-gate' &&
        fact.entry.action.kind !== 'pipeline-apply-choice',
      action: fact.entry.action
    })
  }

  for (const landed of landedChoiceAttempts(ledger)) {
    events.push({
      atMs: landed.fact.entry.atMs,
      order: entryOrder.get(landed.fact.entry.eventId) ?? 0,
      kind: 'choice',
      instanceId: landed.fact.identity.instanceId,
      epoch: landed.fact.identity.epoch,
      attempt: landed.fact.identity.attempt,
      choice: landed.choice,
      ...(landed.comment === undefined ? {} : { comment: landed.comment }),
      ...(landed.extendMinutes === undefined ? {} : { extendMinutes: landed.extendMinutes }),
      action: landed.fact.entry.action
    })
  }
  events.sort((left, right) => left.atMs - right.atMs || left.order - right.order)

  for (const event of events) {
    state.position = event.order
    const currentEpoch = state.epochs.get(event.instanceId) ?? 0
    if (currentEpoch < event.epoch) {
      state.epochs.set(event.instanceId, event.epoch)
      state.epochAdvancedAt.set(
        event.instanceId,
        state.epochDispatchedAt.get(epochKey(event.instanceId, event.epoch)) ?? event.order
      )
    }
    if (event.kind === 'attempt') {
      if (event.failed) {
        const failedCount = (state.failures.get(event.instanceId) ?? 0) + 1
        state.failures.set(event.instanceId, failedCount)
        state.attempts.set(
          event.instanceId,
          Math.max(state.attempts.get(event.instanceId) ?? 0, event.attempt + 1)
        )
        const target = failureSendBackTarget(document, event.instanceId)
        if (
          target !== undefined &&
          failureHasAutomaticRepair(document, event.instanceId) &&
          failedCount <= retryLimit(document, event.instanceId)
        ) {
          advanceRepairPath(
            document,
            state,
            target,
            nodeIdFromInstanceId(event.instanceId),
            event.epoch,
            true
          )
        }
      } else if (event.actionKind === 'pipeline-dispatch-agent') {
        state.attempts.set(
          event.instanceId,
          Math.max(state.attempts.get(event.instanceId) ?? 0, event.attempt)
        )
      }
      continue
    }
    applyChoiceTransition(document, state, event)
  }
  state.position = ledger.entries.length
  return state
}

function applyChoiceTransition(
  document: PipelineDocument,
  state: PipelineHistoryState,
  event: Extract<HistoryEvent, { kind: 'choice' }>
): void {
  const nodeId = nodeIdFromInstanceId(event.instanceId)
  const node = document.nodes.find((candidate) => candidate.id === nodeId)
  switch (event.choice) {
    case 'approve':
      if (node?.type === 'gate') {
        state.gateOutputs.set(nodeId, {
          decision: 'approve',
          ...(event.comment === undefined ? {} : { comment: event.comment })
        })
      }
      return
    case 'send-back': {
      const target =
        node?.type === 'gate' ? node.sendBackTo : failureSendBackTarget(document, event.instanceId)
      if (target !== undefined) {
        advanceRepairPath(document, state, target, nodeId, event.epoch, false, event.comment)
      }
      return
    }
    case 'retry': {
      const nextEpoch = Math.max(state.epochs.get(event.instanceId) ?? event.epoch, event.epoch) + 1
      state.epochs.set(event.instanceId, nextEpoch)
      state.epochAdvancedAt.set(event.instanceId, state.position)
      state.attempts.set(event.instanceId, 0)
      state.failures.set(event.instanceId, 0)
      return
    }
    case 'skip':
      if ('cause' in event.action && event.action.cause === 'merge-conflict') {
        const childInstanceId = actionString(event.action, 'conflictingChildInstanceId')
        if (childInstanceId !== null) {
          state.skipped.add(childInstanceId)
        }
      } else {
        state.skipped.add(event.instanceId)
      }
      return
    case 'abort':
      state.aborted = true
      return
    case 'accept':
      state.acceptedLoops.set(nodeId, event.epoch)
      return
    case 'one-more-round': {
      if (node?.type !== 'loop') {
        return
      }
      const reference = pipelineOutputReference(node.until)
      if (reference === null) {
        return
      }
      const triggerEpoch = state.epochs.get(reference.nodeId) ?? event.epoch
      advancePipelineLoopRound(document, state, nodeId, reference.nodeId, triggerEpoch)
      const seen = (state.oneMoreChoicesSeen.get(nodeId) ?? 0) + 1
      state.oneMoreChoicesSeen.set(nodeId, seen)
      if ((state.loopExtraRounds.get(nodeId) ?? 0) < seen) {
        state.loopExtraRounds.set(nodeId, seen)
      }
      break
    }
    case 'extend':
  }
}

function actionString(action: KernelAction, field: string): string | null {
  const value = action[field]
  return typeof value === 'string' ? value : null
}

export function advancePipelineLoopRound(
  document: PipelineDocument,
  state: PipelineHistoryState,
  loopId: string,
  sourceNodeId: string,
  sourceEpoch: number
): void {
  const loop = document.nodes.find((candidate) => candidate.id === loopId)
  if (loop?.type !== 'loop' || (state.epochs.get(sourceNodeId) ?? 0) > sourceEpoch) {
    return
  }
  advanceRepairPath(
    document,
    state,
    loopReentryNode(document, loop),
    sourceNodeId,
    sourceEpoch,
    false
  )
  const round = Math.max(
    state.loopRounds.get(loopId) ?? 1,
    ...loop.body.map((nodeId) => (state.epochs.get(nodeId) ?? 0) + 1)
  )
  state.loopRounds.set(loopId, round)
}

/** Returns the send-back comment a node should see when it dispatches in `epoch`, if any. */
export function pipelineSendBackComment(
  history: PipelineHistoryState,
  instanceId: string,
  epoch: number
): string | undefined {
  const stored = history.sendBackComments.get(instanceId)
  return stored?.epoch === epoch ? stored.comment : undefined
}

export function derivePipelineHistory(
  document: PipelineDocument,
  ledger: WatcherLedger
): PipelineHistoryState {
  return startFromLedger(document, ledger)
}
