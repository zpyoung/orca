import { getAttemptResolution } from '../../shared/fork-heimdall/ledger-queries'
import type { AttemptEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import {
  pipelineAttemptFacts,
  type PipelineAttemptFact
} from '../../shared/fork-heimdall-pipeline/interpreter/node-history'
import {
  childTaskIdFromInstanceId,
  nodeInstanceId,
  pipelineNodeIdentity
} from '../../shared/fork-heimdall-pipeline/interpreter/node-instance'
import type { PipelineNodeRunState } from '../../shared/fork-heimdall-pipeline/interpreter'
import type { PipelineStoreFacts } from '../../shared/fork-heimdall-pipeline/store-facts'

function textField(attempt: AttemptEntry, key: string): string | undefined {
  const value = attempt.action[key]
  return typeof value === 'string' ? value : undefined
}

function settledLandedChildDispatch(
  attemptFacts: readonly PipelineAttemptFact[],
  instanceId: string,
  epoch: number,
  attempt: number,
  dispatchId: string
): boolean {
  for (const fact of attemptFacts) {
    if (
      fact.entry.action.kind === 'pipeline-dispatch-agent' &&
      fact.identity.instanceId === instanceId &&
      fact.identity.epoch === epoch &&
      fact.identity.attempt === attempt &&
      fact.entry.state === 'settled' &&
      fact.effect === 'landed' &&
      (fact.entry.dispatchId === undefined || fact.entry.dispatchId === dispatchId)
    ) {
      return true
    }
  }
  return false
}

export type PipelineMergeResolverDispatch = {
  nodeId: string
  epoch: number
  dispatchId: string
  startedAtMs: number
  attempt: AttemptEntry
}

export type PipelineMergeResolverDispatchIndex = {
  byDispatchId: ReadonlyMap<string, string>
  turnsFromAtMsByDispatchId: ReadonlyMap<string, number>
  turnAttributionsByDispatchId: ReadonlyMap<
    string,
    readonly { nodeId: string; startedAtMs: number }[]
  >
  byNodeId: ReadonlyMap<string, readonly PipelineMergeResolverDispatch[]>
}

/** Maps private conflict-resolution actions to the original landed child dispatch. */
export function pipelineMergeResolverDispatchIndex(
  facts: PipelineStoreFacts,
  attempts: readonly AttemptEntry[],
  nodeStates: ReadonlyMap<string, PipelineNodeRunState>,
  ledger: WatcherLedger
): PipelineMergeResolverDispatchIndex {
  const attemptFacts = pipelineAttemptFacts(ledger)
  const byDispatchId = new Map<string, string>()
  const turnsFromAtMsByDispatchId = new Map<string, number>()
  const assignedAtMsByDispatchId = new Map<string, number>()
  const turnAttributionsByDispatchId = new Map<string, { nodeId: string; startedAtMs: number }[]>()
  const byNodeId = new Map<string, PipelineMergeResolverDispatch[]>()
  for (const attempt of attempts) {
    if (attempt.action.kind !== 'pipeline-resolve-merge-conflict') {
      continue
    }
    const identity = pipelineNodeIdentity(attempt.action)
    const childInstanceId = textField(attempt, 'childInstanceId')
    const taskId = childInstanceId === undefined ? null : childTaskIdFromInstanceId(childInstanceId)
    const mergeState = identity === null ? undefined : nodeStates.get(identity.nodeId)
    if (
      identity === null ||
      childInstanceId === undefined ||
      taskId === null ||
      mergeState === undefined ||
      identity.epoch !== mergeState.epoch ||
      identity.attempt !== mergeState.attempt ||
      textField(attempt, 'mergeId') !== identity.nodeId ||
      textField(attempt, 'taskId') !== taskId ||
      identity.instanceId !== nodeInstanceId(identity.nodeId, taskId)
    ) {
      continue
    }
    const childState = nodeStates.get(childInstanceId)
    if (childState === undefined || childState.status !== 'done') {
      continue
    }
    let dispatch: PipelineStoreFacts['dispatches'][number] | undefined
    for (const candidate of facts.dispatches) {
      if (
        candidate.instanceId === childInstanceId &&
        candidate.epoch === childState.epoch &&
        candidate.attempt === childState.attempt &&
        (dispatch === undefined || candidate.dispatchedAtMs > dispatch.dispatchedAtMs)
      ) {
        dispatch = candidate
      }
    }
    if (
      dispatch === undefined ||
      !settledLandedChildDispatch(
        attemptFacts,
        childInstanceId,
        childState.epoch,
        childState.attempt,
        dispatch.dispatchId
      )
    ) {
      continue
    }
    const resolver = {
      nodeId: identity.nodeId,
      epoch: identity.epoch,
      dispatchId: dispatch.dispatchId,
      startedAtMs: attempt.atMs,
      attempt
    }
    const currentNodeStart = assignedAtMsByDispatchId.get(resolver.dispatchId)
    if (currentNodeStart === undefined || resolver.startedAtMs >= currentNodeStart) {
      byDispatchId.set(resolver.dispatchId, resolver.nodeId)
      assignedAtMsByDispatchId.set(resolver.dispatchId, resolver.startedAtMs)
    }
    const turnStart = turnsFromAtMsByDispatchId.get(resolver.dispatchId)
    if (turnStart === undefined || resolver.startedAtMs < turnStart) {
      turnsFromAtMsByDispatchId.set(resolver.dispatchId, resolver.startedAtMs)
    }
    const turnAttributions = turnAttributionsByDispatchId.get(resolver.dispatchId) ?? []
    turnAttributions.push({ nodeId: resolver.nodeId, startedAtMs: resolver.startedAtMs })
    turnAttributionsByDispatchId.set(resolver.dispatchId, turnAttributions)
    const resolvers = byNodeId.get(resolver.nodeId) ?? []
    resolvers.push(resolver)
    byNodeId.set(resolver.nodeId, resolvers)
  }
  return { byDispatchId, turnsFromAtMsByDispatchId, turnAttributionsByDispatchId, byNodeId }
}

/** Extends Merge node timing to include private conflict-resolution attempts. */
export function pipelineMergeResolverTiming(input: {
  nodeType: string | undefined
  nodeId: string
  epoch: number
  ledger: WatcherLedger
  nowMs: number
  baseTiming: { startedAtMs?: number; elapsedMs?: number }
  mergeResolvers: PipelineMergeResolverDispatchIndex
}): { startedAtMs?: number; elapsedMs?: number } {
  if (input.nodeType !== 'merge') {
    return input.baseTiming
  }
  let startedAtMs = input.baseTiming.startedAtMs
  let endedAtMs =
    startedAtMs === undefined || input.baseTiming.elapsedMs === undefined
      ? undefined
      : startedAtMs + input.baseTiming.elapsedMs
  for (const resolver of input.mergeResolvers.byNodeId.get(input.nodeId) ?? []) {
    if (resolver.epoch !== input.epoch) {
      continue
    }
    startedAtMs =
      startedAtMs === undefined ? resolver.startedAtMs : Math.min(startedAtMs, resolver.startedAtMs)
    const resolution = getAttemptResolution(input.ledger, resolver.attempt.attemptId)
    let lastTurnAtMs = resolver.startedAtMs
    for (const entry of input.ledger.entries) {
      if (entry.kind === 'turn' && entry.dispatchId === resolver.dispatchId) {
        lastTurnAtMs = Math.max(lastTurnAtMs, entry.atMs)
      }
    }
    const active =
      resolution === null &&
      (resolver.attempt.state === 'attempted' ||
        resolver.attempt.state === 'running' ||
        resolver.attempt.effect === 'indeterminate')
    const resolverEndMs = active
      ? input.nowMs
      : (resolution?.atMs ??
        (resolver.attempt.state === 'settled' ? resolver.attempt.atMs : lastTurnAtMs))
    endedAtMs = endedAtMs === undefined ? resolverEndMs : Math.max(endedAtMs, resolverEndMs)
  }
  return startedAtMs === undefined || endedAtMs === undefined
    ? input.baseTiming
    : { startedAtMs, elapsedMs: Math.max(0, endedAtMs - startedAtMs) }
}

export function pipelineTurnsByInstance(
  facts: PipelineStoreFacts,
  ledger: WatcherLedger,
  mergeResolvers: PipelineMergeResolverDispatchIndex
): Map<string, number> {
  const instanceByDispatchId = new Map(
    facts.dispatches.map((dispatch) => [dispatch.dispatchId, dispatch.instanceId])
  )
  const result = new Map<string, number>()
  for (const entry of ledger.entries) {
    if (entry.kind !== 'turn') {
      continue
    }
    const instanceId = instanceByDispatchId.get(entry.dispatchId)
    if (instanceId === undefined) {
      continue
    }
    let attribution = instanceId
    let latestResolverAtMs = -1
    for (const resolver of mergeResolvers.turnAttributionsByDispatchId.get(entry.dispatchId) ??
      []) {
      if (resolver.startedAtMs <= entry.atMs && resolver.startedAtMs >= latestResolverAtMs) {
        attribution = resolver.nodeId
        latestResolverAtMs = resolver.startedAtMs
      }
    }
    result.set(attribution, (result.get(attribution) ?? 0) + 1)
  }
  return result
}
