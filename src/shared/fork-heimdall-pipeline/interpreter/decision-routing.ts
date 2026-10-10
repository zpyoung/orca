import type { WatcherLedger } from '../../fork-heimdall/ledger-types'
import type { Deviation } from '../../fork-heimdall/owner/deviation'
import type { PipelineNode } from '../document-schema'
import type { PipelineWorld, PipelineNodeRunState } from './index'
import type { PipelineChoiceCause } from '../choice-types'
import { pipelineAttemptDeadline } from './time-limit-rules'
import { pipelineAttemptFacts, type PipelineAttemptFact } from './node-history'
import type { Candidate } from './decision-types'
import { optionsForNode } from './decision-types'
import { routeNodeChoice, ownerEscalationStatus } from './decision-choices'

export function addDeviation(
  deviations: { order: number; deviation: Deviation }[],
  order: number,
  deviation: Deviation
): void {
  deviations.push({ order, deviation })
}

export function latestSwarmExpansion(
  world: PipelineWorld,
  nodeId: string,
  epoch: number
): PipelineWorld['facts']['swarmExpansions'][number] | undefined {
  let expansion: PipelineWorld['facts']['swarmExpansions'][number] | undefined
  for (const candidate of world.facts.swarmExpansions) {
    if (candidate.swarmId === nodeId && candidate.epoch === epoch) {
      expansion = candidate
    }
  }
  return expansion
}

export function routeChoiceForNode(input: {
  world: PipelineWorld
  ledger: WatcherLedger
  node: PipelineNode
  instanceId: string
  state: PipelineNodeRunState
  cause: PipelineChoiceCause
  deadlineMs?: number
  detail: string
  fields?: Record<string, unknown>
  order: number
}): { deviation?: Deviation; candidate?: Candidate } {
  const route = routeNodeChoice({
    world: input.world,
    ledger: input.ledger,
    node: input.node,
    instanceId: input.instanceId,
    epoch: input.state.epoch,
    attempt: input.state.attempt,
    cause: input.cause,
    options: optionsForNode(input.node, input.instanceId, input.cause),
    ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
    detail: input.detail,
    ...(input.fields === undefined ? {} : { fields: input.fields }),
    order: input.order
  })
  return {
    ...(route.deviation === undefined ? {} : { deviation: route.deviation }),
    ...(route.candidate === undefined ? {} : { candidate: route.candidate })
  }
}

function runningAgentAttempt(
  ledger: WatcherLedger,
  instanceId: string,
  epoch: number
): PipelineAttemptFact | null {
  let latest: PipelineAttemptFact | null = null
  for (const fact of pipelineAttemptFacts(ledger)) {
    if (
      fact.identity.instanceId === instanceId &&
      fact.identity.epoch === epoch &&
      fact.entry.action.kind === 'pipeline-dispatch-agent' &&
      fact.entry.state === 'running' &&
      (latest === null || fact.entry.atMs >= latest.entry.atMs)
    ) {
      latest = fact
    }
  }
  return latest
}

export function addTimeLimitChoice(input: {
  world: PipelineWorld
  ledger: WatcherLedger
  node: PipelineNode
  instanceId: string
  state: PipelineNodeRunState
  order: number
  candidates: Candidate[]
  deviations: { order: number; deviation: Deviation }[]
}): void {
  if (input.state.status !== 'running') {
    return
  }
  const attempt = runningAgentAttempt(input.ledger, input.instanceId, input.state.epoch)
  if (attempt === null) {
    return
  }
  const deadline = pipelineAttemptDeadline({
    payload: input.world.payload,
    facts: input.world.facts,
    ledger: input.ledger,
    attempt
  })
  if (
    deadline === null ||
    input.world.nowMs < deadline.atMs ||
    (deadline.dispatchId !== undefined &&
      input.world.unverifiableDispatchIds.has(deadline.dispatchId))
  ) {
    return
  }
  const nodeState = { ...input.state, epoch: deadline.epoch, attempt: deadline.attempt }
  const route = routeChoiceForNode({
    world: input.world,
    ledger: input.ledger,
    node: input.node,
    instanceId: input.instanceId,
    state: nodeState,
    cause: 'time-limit',
    deadlineMs: deadline.atMs,
    detail: `Node ${input.instanceId} exceeded its time limit at ${deadline.atMs}`,
    order: input.order
  })
  if (route.deviation !== undefined) {
    addDeviation(input.deviations, input.order, route.deviation)
  }
  if (route.candidate !== undefined) {
    input.candidates.push(route.candidate)
  }
}

export function routeGenericOwnerDeviation(input: {
  world: PipelineWorld
  ledger: WatcherLedger
  deviation: Deviation
  order: number
}): Deviation | null {
  return !input.world.hasOwner ||
    ownerEscalationStatus(input.world.watcherId, input.ledger, input.deviation) !== 'new'
    ? null
    : input.deviation
}
