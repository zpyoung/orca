import type { WatcherLedger } from '../../fork-heimdall/ledger-types'

import { PIPELINE_NODE_TYPES } from '../document-schema'
import type { PipelineWorld } from './index'
import { unmatchedPipelineDecision } from './decision-rules'
import { pipelineComplete } from './decision-types'
import { derivePipelineRunState } from './run-state'

const MAX_UNMATCHED_BRANCH_LENGTH = 120

/** Computes the pure terminal or configuration verdict for one pipeline read. */
export function pipelineStopVerdict(
  world: PipelineWorld,
  ledger: WatcherLedger
): {
  id: 'pipeline-complete' | 'pipeline-aborted' | 'pipeline-configuration-error'
  detail?: string
} | null {
  if (world.payload.schemaVersion !== 1) {
    return { id: 'pipeline-configuration-error', detail: 'kindPayload.schemaVersion' }
  }
  const pin = world.facts.pin
  if (
    pin !== null &&
    (pin.id !== world.payload.pin.id ||
      pin.ref !== world.payload.pin.ref ||
      pin.scope !== world.payload.pin.scope ||
      pin.contentHash !== world.payload.pin.contentHash ||
      pin.documentVersion !== world.payload.pin.documentVersion)
  ) {
    return { id: 'pipeline-configuration-error', detail: 'kindPayload.pin.contentHash' }
  }
  const unsupported = world.payload.document.nodes.find(
    (node) => !PIPELINE_NODE_TYPES.some((nodeType) => nodeType === node.type)
  )
  if (unsupported !== undefined) {
    return {
      id: 'pipeline-configuration-error',
      detail: `kindPayload.document.nodes.${unsupported.id}.type`
    }
  }
  const runState = derivePipelineRunState({
    payload: world.payload,
    ledger,
    facts: world.facts,
    nowMs: world.nowMs,
    hasOwner: world.hasOwner,
    unverifiableDispatchIds: world.unverifiableDispatchIds,
    composites: world.composites
  })
  if (runState.terminal === 'aborted') {
    return { id: 'pipeline-aborted' }
  }
  const unmatched = unmatchedPipelineDecision(world.payload.document, runState.nodes)
  if (unmatched !== null) {
    return {
      id: 'pipeline-configuration-error',
      detail: `kindPayload.document.nodes.${unmatched.nodeId}.on: value ${JSON.stringify(unmatched.branch.slice(0, MAX_UNMATCHED_BRANCH_LENGTH))} matches no branch`
    }
  }
  return pipelineComplete(world.payload.document, runState) ? { id: 'pipeline-complete' } : null
}
