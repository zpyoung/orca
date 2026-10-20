import type { PipelineDocument, PipelineNode } from '../document-schema'
import type { PipelineEnrollmentPayload } from '../enrollment-payload'
import type { PipelineStoreFacts } from '../store-facts'
import type { WatcherLedger } from '../../fork-heimdall/ledger-types'
import { landedChoiceAttempts } from './node-history'
import type { PipelineAttemptFact } from './node-history'
import type { PipelineHistoryState } from './state-history'
import type { PipelineNodeRunState } from './index'
import { childTaskIdFromInstanceId } from './node-instance'

function outputRowsFor(
  facts: PipelineStoreFacts,
  instanceId: string,
  epoch: number,
  attempt: number
): Record<string, unknown> | undefined {
  let result: Record<string, unknown> | undefined
  for (const row of facts.outputs) {
    if (row.instanceId === instanceId && row.epoch === epoch && row.attempt === attempt) {
      result = row.outputs
    }
  }
  return result
}

function latestAttemptForNode(
  attempts: readonly PipelineAttemptFact[],
  instanceId: string,
  epoch: number
): PipelineAttemptFact | null {
  let latest: PipelineAttemptFact | null = null
  for (const fact of attempts) {
    if (fact.identity.instanceId !== instanceId || fact.identity.epoch !== epoch) {
      continue
    }
    if (latest === null || fact.entry.atMs >= latest.entry.atMs) {
      latest = fact
    }
  }
  return latest
}

function latestWorkerAttemptForNode(
  attempts: readonly PipelineAttemptFact[],
  instanceId: string,
  epoch: number
): PipelineAttemptFact | null {
  let latest: PipelineAttemptFact | null = null
  for (const fact of attempts) {
    if (
      fact.identity.instanceId !== instanceId ||
      fact.identity.epoch !== epoch ||
      !['pipeline-dispatch-agent', 'pipeline-run-check', 'pipeline-run-script'].includes(
        fact.entry.action.kind
      )
    ) {
      continue
    }
    if (latest === null || fact.entry.atMs >= latest.entry.atMs) {
      latest = fact
    }
  }
  return latest
}

function nodeRetryLimit(document: PipelineDocument, node: PipelineNode, taskId?: string): number {
  if (node.type === 'agent') {
    return node.retry ?? document.defaults?.retry ?? 0
  }
  if (node.type === 'check') {
    return node.retry ?? document.defaults?.retry ?? 0
  }
  if (node.type === 'swarm' && taskId !== undefined) {
    return node.child.retry ?? document.defaults?.retry ?? 0
  }
  if (node.type === 'merge') {
    return document.defaults?.retry ?? 0
  }
  return 0
}

function failureReason(attempt: PipelineAttemptFact): { reason: string; summary?: string } {
  const reason = attempt.entry.reason ?? 'The previous attempt did not land'
  if (
    attempt.entry.result !== null &&
    typeof attempt.entry.result === 'object' &&
    !Array.isArray(attempt.entry.result) &&
    'summary' in attempt.entry.result &&
    typeof attempt.entry.result.summary === 'string'
  ) {
    return { reason, summary: attempt.entry.result.summary }
  }
  return { reason }
}

function agentDeclaresOutputs(node: PipelineNode, instanceId: string): boolean {
  const outputs =
    node.type === 'agent'
      ? node.outputs
      : node.type === 'swarm' && childTaskIdFromInstanceId(instanceId) !== null
        ? node.child.outputs
        : undefined
  return outputs !== undefined && Object.keys(outputs).length > 0
}

/** Land outputs come from the opened review; the PR-sitter composite reads them as its target. */
function landReviewOutputs(result: unknown): Record<string, unknown> {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return {}
  }
  const outputs: Record<string, unknown> = {}
  for (const key of ['prUrl', 'prNumber', 'branch', 'provider', 'headSha']) {
    if (Object.hasOwn(result, key)) {
      outputs[key] = Object.getOwnPropertyDescriptor(result, key)?.value
    }
  }
  return outputs
}

export function pipelineNodeAttemptState(input: {
  node: PipelineNode
  instanceId: string
  epoch: number
  attempt: number
  attempts: readonly PipelineAttemptFact[]
  payload: PipelineEnrollmentPayload
  facts: PipelineStoreFacts
  ledger: WatcherLedger
  unverifiableDispatchIds: ReadonlySet<string>
}): PipelineNodeRunState {
  const selected = latestAttemptForNode(input.attempts, input.instanceId, input.epoch)
  const worker = latestWorkerAttemptForNode(input.attempts, input.instanceId, input.epoch)
  const base = { epoch: input.epoch, attempt: input.attempt }
  if (
    selected !== null &&
    (selected.entry.action.kind === 'pipeline-pass-gate' ||
      selected.entry.action.kind === 'pipeline-apply-choice') &&
    (selected.entry.state !== 'settled' || selected.effect === 'not-landed')
  ) {
    return { ...base, status: 'waiting', waitingFor: 'choice' }
  }
  if (worker !== null && (worker.entry.state === 'attempted' || worker.entry.state === 'running')) {
    const dispatchId = worker.entry.dispatchId
    if (dispatchId !== undefined && input.unverifiableDispatchIds.has(dispatchId)) {
      return { ...base, status: 'unverifiable' }
    }
    return { ...base, status: 'running' }
  }
  if (worker !== null && worker.entry.state === 'settled' && worker.effect === 'indeterminate') {
    const dispatchId = worker.entry.dispatchId
    return {
      ...base,
      status:
        dispatchId !== undefined && input.unverifiableDispatchIds.has(dispatchId)
          ? 'unverifiable'
          : 'running'
    }
  }
  const outputs = outputRowsFor(input.facts, input.instanceId, input.epoch, input.attempt)
  if (selected !== null && selected.entry.state === 'settled' && selected.effect === 'not-landed') {
    const retryLimit = nodeRetryLimit(
      input.payload.document,
      input.node,
      childTaskIdFromInstanceId(input.instanceId) ?? undefined
    )
    const failure = failureReason(selected)
    return input.attempt >= retryLimit + 1
      ? { ...base, status: 'failed', waitingFor: 'choice', failure }
      : { ...base, status: 'ready', failure }
  }
  if (
    outputs !== undefined &&
    selected !== null &&
    selected.entry.state === 'settled' &&
    selected.effect === 'landed'
  ) {
    return { ...base, status: 'done', outputs }
  }
  if (selected !== null && selected.entry.state === 'settled' && selected.effect === 'landed') {
    if (selected.entry.action.kind === 'pipeline-pass-gate') {
      const choice = landedChoiceAttempts(input.ledger).find(
        (landed) => landed.fact.entry.attemptId === selected.entry.attemptId
      )
      return choice?.choice === 'approve'
        ? {
            ...base,
            status: 'done',
            outputs: {
              decision: 'approve',
              ...(choice.comment === undefined ? {} : { comment: choice.comment })
            }
          }
        : { ...base, status: 'waiting', waitingFor: 'choice' }
    }
    if (
      selected.entry.action.kind === 'pipeline-dispatch-agent' &&
      agentDeclaresOutputs(input.node, input.instanceId)
    ) {
      // outputs are written before the landed settlement, so a missing row is a stale store read
      return { ...base, status: 'running' }
    }
    if (
      selected.entry.action.kind === 'pipeline-run-check' ||
      selected.entry.action.kind === 'pipeline-run-script' ||
      selected.entry.action.kind === 'pipeline-dispatch-agent'
    ) {
      return { ...base, status: 'done', outputs: {} }
    }
    if (selected.entry.action.kind === 'pipeline-land-open-review') {
      return { ...base, status: 'done', outputs: landReviewOutputs(selected.entry.result) }
    }
  }
  if (selected !== null && selected.entry.state !== 'settled') {
    return { ...base, status: 'running' }
  }
  return { ...base, status: 'pending' }
}

export function pipelineNodeEpoch(history: PipelineHistoryState, nodeId: string): number {
  return history.epochs.get(nodeId) ?? 0
}

export function pipelineNodeAttempt(history: PipelineHistoryState, nodeId: string): number {
  return history.attempts.get(nodeId) ?? 0
}

export function latestPipelineSwarmExpansion(
  facts: PipelineStoreFacts,
  swarmId: string,
  epoch: number
): PipelineStoreFacts['swarmExpansions'][number] | undefined {
  let expansion: PipelineStoreFacts['swarmExpansions'][number] | undefined
  for (const candidate of facts.swarmExpansions) {
    if (candidate.swarmId === swarmId && candidate.epoch === epoch) {
      expansion = candidate
    }
  }
  return expansion
}
