import type { PipelineDocument } from '../document-schema'
import type { PipelineEnrollmentPayload } from '../enrollment-payload'
import type { PipelineStoreFacts } from '../store-facts'
import type { WatcherLedger } from '../../fork-heimdall/ledger-types'
import type {
  PipelineBuiltInKind,
  PipelineComposite,
  PipelineNodeRunState,
  PipelineRunState
} from './index'
import { resolvePipelineReadiness, type PipelineOutputValues } from './decision-rules'
import { pipelineAttemptFacts } from './node-history'
import { derivePipelineHistory } from './state-history'
import { pipelineAttemptDeadline } from './time-limit-rules'
import {
  pipelineNodeAttempt,
  pipelineNodeAttemptState,
  pipelineNodeEpoch
} from './run-state-actions'
import { applyMergeStates, applySwarmChildStates } from './run-state-fanout'
import {
  advanceOutputDrivenLoopRounds,
  applyLoopStates,
  pipelineGraphIsComplete
} from './run-state-loops'

export type DerivePipelineRunStateInput = {
  payload: PipelineEnrollmentPayload
  ledger: WatcherLedger
  facts: PipelineStoreFacts
  nowMs: number
  hasOwner?: boolean
  unverifiableDispatchIds?: ReadonlySet<string>
  composites?: Readonly<Record<string, PipelineComposite>>
}

function outputsForDecision(
  document: PipelineDocument,
  states: ReadonlyMap<string, PipelineNodeRunState>
): PipelineOutputValues {
  const outputs: Record<string, Record<string, unknown>> = {}
  for (const node of document.nodes) {
    const state = states.get(node.id)
    if (state?.outputs !== undefined) {
      outputs[node.id] = state.outputs
    }
  }
  return outputs
}

/** Derives display and readiness state solely from pinned data, ledger facts, and the supplied clock. */
export function derivePipelineRunState(input: DerivePipelineRunStateInput): PipelineRunState {
  const document = input.payload.document
  const history = derivePipelineHistory(document, input.ledger)
  const attempts = pipelineAttemptFacts(input.ledger)
  advanceOutputDrivenLoopRounds({ document, facts: input.facts, history, attempts })
  const states = new Map<string, PipelineNodeRunState>()
  for (const node of document.nodes) {
    const epoch = pipelineNodeEpoch(history, node.id)
    const attempt = pipelineNodeAttempt(history, node.id)
    const nodeState = pipelineNodeAttemptState({
      node,
      instanceId: node.id,
      epoch,
      attempt,
      attempts,
      payload: input.payload,
      facts: input.facts,
      ledger: input.ledger,
      unverifiableDispatchIds: input.unverifiableDispatchIds ?? new Set()
    })
    const composite = input.composites?.[node.id]
    let state = nodeState
    if (history.skipped.has(node.id)) {
      state = { ...nodeState, status: 'skipped' }
    } else if (composite !== undefined) {
      state = { ...nodeState, phase: composite.phase }
      if (node.type === 'pr-sitter') {
        const stop = composite.evaluateStops()
        if (stop?.disposition === 'terminal') {
          state = { ...state, status: 'done', outputs: { lifecycle: stop.reason } }
        } else if (stop?.disposition === 'park') {
          state = {
            ...state,
            status: 'waiting',
            waitingFor: input.hasOwner && stop.deviation !== undefined ? 'owner' : 'choice',
            failure: {
              reason: stop.reason,
              ...(stop.detail === undefined ? {} : { summary: stop.detail })
            }
          }
        }
      }
    }
    states.set(node.id, state)
  }
  resolvePipelineReadiness(document, states, outputsForDecision(document, states))
  applySwarmChildStates({
    document,
    states,
    history,
    attempts,
    payload: input.payload,
    facts: input.facts,
    ledger: input.ledger,
    unverifiableDispatchIds: input.unverifiableDispatchIds ?? new Set()
  })
  applyMergeStates({
    document,
    states,
    history,
    facts: input.facts,
    attempts,
    unverifiableDispatchIds: input.unverifiableDispatchIds ?? new Set()
  })
  applyLoopStates({
    document,
    states,
    history,
    outputs: outputsForDecision(document, states)
  })
  resolvePipelineReadiness(document, states, outputsForDecision(document, states))
  const deadlines = attempts.flatMap((attempt) => {
    const deadline = pipelineAttemptDeadline({
      payload: input.payload,
      facts: input.facts,
      ledger: input.ledger,
      attempt
    })
    const state = deadline === null ? undefined : states.get(deadline.instanceId)
    return deadline !== null &&
      state?.status === 'running' &&
      state.epoch === deadline.epoch &&
      state.attempt === deadline.attempt &&
      (deadline.dispatchId === undefined ||
        !input.unverifiableDispatchIds?.has(deadline.dispatchId))
      ? [{ instanceId: deadline.instanceId, atMs: deadline.atMs }]
      : []
  })
  return {
    nodes: states,
    terminal: history.aborted
      ? 'aborted'
      : pipelineGraphIsComplete(document, states)
        ? 'complete'
        : null,
    deadlines
  }
}

/** Creates the read-only, one-node projection used by the Objective and PR-sitter built-ins. */
export function builtinOneNodeRunState(
  kind: PipelineBuiltInKind,
  phase: string,
  progress?: { done: number; total: number },
  revision?: number
): PipelineRunState {
  const id = kind === 'objective' ? 'objective' : 'pr-sitter'
  return {
    nodes: new Map([
      [
        id,
        {
          status: phase === 'landed' ? 'done' : 'running',
          epoch: 0,
          attempt: 0,
          phase,
          ...(progress === undefined ? {} : { progress }),
          ...(revision === undefined ? {} : { revision })
        }
      ]
    ]),
    terminal: phase === 'landed' ? 'complete' : null,
    deadlines: []
  }
}
