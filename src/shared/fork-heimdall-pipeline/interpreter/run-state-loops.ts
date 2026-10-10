import type { PipelineDocument } from '../document-schema'
import type { PipelineStoreFacts } from '../store-facts'
import type { PipelineNodeRunState } from './index'
import type { PipelineOutputValues } from './decision-rules'
import { pipelineOutputReference } from './decision-rules'
import type { PipelineAttemptFact } from './node-history'
import type { PipelineHistoryState } from './state-history'
import { advancePipelineLoopRound } from './state-history'
import { decodePipelineVerdict } from './verdict-output'

export function advanceOutputDrivenLoopRounds(input: {
  document: PipelineDocument
  facts: PipelineStoreFacts
  history: PipelineHistoryState
  attempts: readonly PipelineAttemptFact[]
}): void {
  for (const node of input.document.nodes) {
    if (node.type !== 'loop') {
      continue
    }
    const reference = pipelineOutputReference(node.until)
    if (reference === null) {
      continue
    }
    const currentRound = Math.max(
      input.history.loopRounds.get(node.id) ?? 1,
      ...node.body.map((bodyNodeId) => (input.history.epochs.get(bodyNodeId) ?? 0) + 1)
    )
    const maximumRounds = node.maxRounds + (input.history.loopExtraRounds.get(node.id) ?? 0)
    if (currentRound >= maximumRounds) {
      continue
    }
    let latestOutput: PipelineStoreFacts['outputs'][number] | undefined
    for (const output of input.facts.outputs) {
      if (
        output.instanceId === reference.nodeId &&
        output.epoch === (input.history.epochs.get(reference.nodeId) ?? 0) &&
        (latestOutput === undefined || output.attempt >= latestOutput.attempt)
      ) {
        latestOutput = output
      }
    }
    const output = latestOutput
    const verdict =
      output === undefined ? null : decodePipelineVerdict(output.outputs[reference.name])
    if (output === undefined || verdict?.verdict !== 'revise') {
      continue
    }
    const landed = input.attempts.some(
      (attempt) =>
        attempt.identity.instanceId === output.instanceId &&
        attempt.identity.epoch === output.epoch &&
        attempt.identity.attempt === output.attempt &&
        attempt.entry.state === 'settled' &&
        attempt.effect === 'landed'
    )
    if (landed) {
      advancePipelineLoopRound(
        input.document,
        input.history,
        node.id,
        reference.nodeId,
        output.epoch
      )
    }
  }
}

export function applyLoopStates(input: {
  document: PipelineDocument
  states: Map<string, PipelineNodeRunState>
  history: PipelineHistoryState
  outputs: PipelineOutputValues
}): void {
  for (const node of input.document.nodes) {
    if (node.type !== 'loop') {
      continue
    }
    const state = input.states.get(node.id)
    if (state === undefined) {
      continue
    }
    const accepted = input.history.acceptedLoops.get(node.id) === state.epoch
    const round = Math.max(
      input.history.loopRounds.get(node.id) ?? 1,
      ...node.body.map((nodeId) => (input.history.epochs.get(nodeId) ?? 0) + 1)
    )
    if (
      state.status !== 'ready' &&
      state.status !== 'running' &&
      state.status !== 'waiting' &&
      state.status !== 'done' &&
      !(state.status === 'pending' && (round > 1 || accepted))
    ) {
      continue
    }
    const reference = pipelineOutputReference(node.until)
    const verdictValue =
      reference === null ? undefined : input.outputs[reference.nodeId]?.[reference.name]
    const verdict = decodePipelineVerdict(verdictValue)
    const loopOutputs =
      reference === null || verdictValue === undefined
        ? undefined
        : { [reference.name]: verdictValue }
    if (accepted) {
      input.states.set(node.id, {
        ...state,
        status: 'done',
        round,
        ...(loopOutputs === undefined ? {} : { outputs: loopOutputs })
      })
    } else if (verdict?.verdict === 'approve') {
      input.states.set(node.id, {
        ...state,
        status: 'done',
        round,
        ...(loopOutputs === undefined ? {} : { outputs: loopOutputs })
      })
    } else if (
      verdict?.verdict === 'escalate' ||
      (verdict?.verdict === 'revise' &&
        round >= node.maxRounds + (input.history.loopExtraRounds.get(node.id) ?? 0))
    ) {
      input.states.set(node.id, { ...state, status: 'waiting', round, waitingFor: 'choice' })
    } else {
      input.states.set(node.id, { ...state, status: 'running', round })
    }
  }
}

export function pipelineGraphIsComplete(
  document: PipelineDocument,
  states: ReadonlyMap<string, PipelineNodeRunState>
): boolean {
  const sourcesWithChildren = new Set<string>()
  for (const node of document.nodes) {
    for (const edge of node.after ?? []) {
      sourcesWithChildren.add(typeof edge === 'string' ? edge : edge.node)
    }
  }
  const sinks = document.nodes.filter((node) => !sourcesWithChildren.has(node.id))
  return (
    sinks.length > 0 &&
    sinks.every((node) => {
      const status = states.get(node.id)?.status
      return status === 'done' || status === 'skipped'
    })
  )
}
