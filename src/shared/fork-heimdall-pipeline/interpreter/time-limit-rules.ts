import type { PipelineDocument } from '../document-schema'
import type { PipelineEnrollmentPayload } from '../enrollment-payload'
import type { PipelineStoreFacts } from '../store-facts'
import type { WatcherLedger } from '../../fork-heimdall/ledger-types'
import { parsePipelineNodeEvidenceKey } from '../choice-types'
import { landedChoiceAttempts, type PipelineAttemptFact } from './node-history'
import { childTaskIdFromInstanceId, nodeIdFromInstanceId } from './node-instance'

export type PipelineAttemptDeadline = {
  instanceId: string
  epoch: number
  attempt: number
  dispatchId?: string
  atMs: number
}

function nodeTimeLimit(document: PipelineDocument, instanceId: string): number | undefined {
  const nodeId = nodeIdFromInstanceId(instanceId)
  const node = document.nodes.find((candidate) => candidate.id === nodeId)
  if (node?.type === 'agent') {
    return node.timeLimitMinutes ?? document.defaults?.timeLimitMinutes
  }
  if (node?.type === 'swarm' && childTaskIdFromInstanceId(instanceId) !== null) {
    return node.child.timeLimitMinutes ?? document.defaults?.timeLimitMinutes
  }
  return undefined
}

/** Returns a deadline only for a worker dispatch with a node time limit. */
export function pipelineAttemptDeadline(input: {
  payload: PipelineEnrollmentPayload
  facts: PipelineStoreFacts
  ledger: WatcherLedger
  attempt: PipelineAttemptFact
}): PipelineAttemptDeadline | null {
  const { entry, identity } = input.attempt
  if (entry.action.kind !== 'pipeline-dispatch-agent' || entry.state !== 'running') {
    return null
  }
  const minutes = nodeTimeLimit(input.payload.document, identity.instanceId)
  if (minutes === undefined) {
    return null
  }
  const dispatch = input.facts.dispatches.find(
    (candidate) =>
      candidate.instanceId === identity.instanceId &&
      candidate.epoch === identity.epoch &&
      candidate.attempt === identity.attempt
  )
  const extensions = landedChoiceAttempts(input.ledger).reduce((total, choice) => {
    const key = parsePipelineNodeEvidenceKey(choice.fact.entry.action.evidenceKey)
    return choice.fact.identity.instanceId === identity.instanceId &&
      choice.fact.identity.epoch === identity.epoch &&
      choice.fact.identity.attempt === identity.attempt &&
      key?.cause === 'time-limit' &&
      choice.choice === 'extend'
      ? total + (choice.extendMinutes ?? 0)
      : total
  }, 0)
  return {
    instanceId: identity.instanceId,
    epoch: identity.epoch,
    attempt: identity.attempt,
    ...(entry.dispatchId === undefined
      ? dispatch?.dispatchId === undefined
        ? {}
        : { dispatchId: dispatch.dispatchId }
      : { dispatchId: entry.dispatchId }),
    atMs: (dispatch?.dispatchedAtMs ?? entry.atMs) + minutes * 60_000 + extensions * 60_000
  }
}
