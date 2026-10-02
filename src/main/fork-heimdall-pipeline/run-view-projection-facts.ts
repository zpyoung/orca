import {
  getAttemptResolution,
  getInFlightAttempts,
  getLatestApproval
} from '../../shared/fork-heimdall/ledger-queries'
import type {
  ApprovalScope,
  AttemptEntry,
  EscalationEntry,
  WatcherLedger
} from '../../shared/fork-heimdall/ledger-types'
import { ObjectiveActionSchema } from '../../shared/fork-heimdall-objective/objective-actions'
import type { WatcherWorker, WatcherWorkerNavigation } from '../../shared/fork-heimdall/fleet-types'
import {
  childTaskIdFromInstanceId,
  pipelineNodeIdentity,
  type PipelineNodeIdentity
} from '../../shared/fork-heimdall-pipeline/interpreter/node-instance'
import type { PipelineNodeRunState } from '../../shared/fork-heimdall-pipeline/interpreter'
import type { PipelineStoreFacts } from '../../shared/fork-heimdall-pipeline/store-facts'
import type { PipelineNode } from '../../shared/fork-heimdall-pipeline/document-schema'
import {
  parsePipelineNodeEvidenceKey,
  pipelineChoiceOptions,
  type ParsedPipelineNodeEvidenceKey
} from '../../shared/fork-heimdall-pipeline/choice-types'
import type { PipelineMergeResolverDispatchIndex } from './run-view-projection-merge'

export type PipelineWorkerNavigationIndex = {
  byDispatchId: ReadonlyMap<string, WatcherWorkerNavigation>
  latest: WatcherWorkerNavigation | undefined
}

type PipelineAttemptIdentity = Pick<PipelineNodeIdentity, 'instanceId' | 'epoch' | 'attempt'>

export function pipelinePlanReviewInFlight(ledger: WatcherLedger): boolean {
  for (const attempt of getInFlightAttempts(ledger)) {
    const action = ObjectiveActionSchema.safeParse(attempt.action)
    if (action.success && action.data.kind === 'dispatch-plan-review') {
      return true
    }
  }
  return false
}

export function pipelineLatestAttempt(
  attempts: readonly AttemptEntry[],
  instanceId: string,
  epoch: number,
  attemptNumber: number
): AttemptEntry | undefined {
  let latest: AttemptEntry | undefined
  for (const attempt of attempts) {
    const identity = pipelineNodeIdentity(attempt.action)
    if (
      identity?.instanceId === instanceId &&
      identity.epoch === epoch &&
      identity.attempt === attemptNumber &&
      (latest === undefined || attempt.atMs > latest.atMs)
    ) {
      latest = attempt
    }
  }
  return latest
}

export function pipelineNodeTiming(input: {
  instanceId: string
  epoch: number
  attempt: number
  status: string
  ledger: WatcherLedger
  attempts: readonly AttemptEntry[]
  facts: PipelineStoreFacts
  mergeResolvers: PipelineMergeResolverDispatchIndex
  nowMs: number
}): { startedAtMs?: number; elapsedMs?: number } {
  const dispatch = input.facts.dispatches.find(
    (row) =>
      row.instanceId === input.instanceId &&
      row.epoch === input.epoch &&
      row.attempt === input.attempt
  )
  const attempt = pipelineLatestAttempt(
    input.attempts,
    input.instanceId,
    input.epoch,
    input.attempt
  )
  const startedAtMs = dispatch?.dispatchedAtMs ?? attempt?.atMs
  if (startedAtMs === undefined) {
    return {}
  }
  const resolution = attempt ? getAttemptResolution(input.ledger, attempt.attemptId) : null
  const resolverStartedAtMs =
    dispatch === undefined
      ? undefined
      : input.mergeResolvers.turnsFromAtMsByDispatchId.get(dispatch.dispatchId)
  let lastTurnAtMs = startedAtMs
  if (dispatch) {
    for (const entry of input.ledger.entries) {
      if (
        entry.kind === 'turn' &&
        entry.dispatchId === dispatch.dispatchId &&
        (resolverStartedAtMs === undefined || entry.atMs < resolverStartedAtMs)
      ) {
        lastTurnAtMs = Math.max(lastTurnAtMs, entry.atMs)
      }
    }
  }
  const active =
    input.status === 'running' || input.status === 'waiting' || input.status === 'unverifiable'
  const endedAtMs = active
    ? input.nowMs
    : (resolution?.atMs ?? (attempt?.state === 'settled' ? attempt.atMs : lastTurnAtMs))
  return { startedAtMs, elapsedMs: Math.max(0, endedAtMs - startedAtMs) }
}

export type PipelineNodeApproval = {
  escalationId: string
  waitingFor: 'gate' | 'choice' | 'capability-approval'
}

function pipelineActionWaitFor(input: {
  node: PipelineNode
  instanceId: string
  scope: ApprovalScope
  key: ParsedPipelineNodeEvidenceKey
}): PipelineNodeApproval['waitingFor'] | null {
  const { node, instanceId, scope, key } = input
  if (scope.actionKind === 'pipeline-pass-gate') {
    return node.type === 'gate' && key.cause === 'gate' && key.step === undefined ? 'gate' : null
  }
  if (scope.actionKind === 'pipeline-apply-choice') {
    if (key.cause === undefined || key.cause === 'gate' || key.step !== undefined) {
      return null
    }
    const nodeType =
      node.type === 'swarm' && childTaskIdFromInstanceId(instanceId) !== null ? 'agent' : node.type
    const sendBackTo = node.type === 'gate' ? node.sendBackTo : undefined
    const onFailSendBackTo =
      node.type === 'agent' || node.type === 'check' ? node.onFail?.sendBackTo : undefined
    const options = pipelineChoiceOptions({
      nodeType,
      cause: key.cause,
      ...(sendBackTo === undefined ? {} : { gateSendBackTo: sendBackTo }),
      ...(onFailSendBackTo === undefined ? {} : { onFailSendBackTo })
    })
    return options.length > 0 ? 'choice' : null
  }

  if (key.cause !== undefined || key.innerContentIdentity !== undefined) {
    return null
  }
  const actionMatchesNode =
    (scope.actionKind === 'pipeline-dispatch-agent' &&
      (node.type === 'agent' ||
        (node.type === 'swarm' && childTaskIdFromInstanceId(instanceId) !== null))) ||
    (scope.actionKind === 'pipeline-run-check' && node.type === 'check') ||
    (scope.actionKind === 'pipeline-run-script' && node.type === 'script') ||
    ((scope.actionKind === 'pipeline-land-commit' ||
      scope.actionKind === 'pipeline-land-push' ||
      scope.actionKind === 'pipeline-land-open-review') &&
      node.type === 'land') ||
    (scope.actionKind === 'pipeline-expand-swarm' && node.type === 'swarm') ||
    (scope.actionKind === 'pipeline-merge-child' && node.type === 'merge') ||
    (scope.actionKind === 'pipeline-resolve-merge-conflict' && node.type === 'merge') ||
    (scope.actionKind === 'pipeline-activate-composite' && node.type === 'pr-sitter')
  if (!actionMatchesNode) {
    return null
  }

  if (scope.actionKind === 'pipeline-run-script') {
    return key.step !== undefined && /^script:sha256:[a-f0-9]{64}$/u.test(key.step)
      ? 'capability-approval'
      : null
  }
  if (scope.actionKind === 'pipeline-land-commit') {
    return key.step === undefined ? 'capability-approval' : null
  }
  if (
    scope.actionKind === 'pipeline-land-push' ||
    scope.actionKind === 'pipeline-land-open-review'
  ) {
    if (key.step === undefined) {
      return null
    }
    try {
      const nativeStep: unknown = JSON.parse(key.step)
      const expectedLength = scope.actionKind === 'pipeline-land-push' ? 6 : 11
      return Array.isArray(nativeStep) &&
        nativeStep.length === expectedLength &&
        nativeStep[0] === scope.actionKind &&
        (scope.actionKind === 'pipeline-land-push' || typeof nativeStep[10] === 'boolean')
        ? 'capability-approval'
        : null
    } catch {
      return null
    }
  }
  if (
    scope.actionKind === 'pipeline-merge-child' ||
    scope.actionKind === 'pipeline-resolve-merge-conflict'
  ) {
    return key.step === undefined ? null : 'capability-approval'
  }
  return key.step === undefined ? 'capability-approval' : null
}
type PipelineLandActionKind =
  | 'pipeline-land-commit'
  | 'pipeline-land-push'
  | 'pipeline-land-open-review'

function pipelineCurrentLandActionKind(input: {
  attempts: readonly AttemptEntry[]
  ledger: WatcherLedger
  identity: PipelineAttemptIdentity
}): PipelineLandActionKind | null {
  let latest: AttemptEntry | undefined
  for (const attempt of input.attempts) {
    const identity = pipelineNodeIdentity(attempt.action)
    if (
      identity?.instanceId !== input.identity.instanceId ||
      identity.epoch !== input.identity.epoch ||
      (attempt.action.kind !== 'pipeline-land-commit' &&
        attempt.action.kind !== 'pipeline-land-push' &&
        attempt.action.kind !== 'pipeline-land-open-review') ||
      (latest !== undefined && attempt.atMs < latest.atMs)
    ) {
      continue
    }
    latest = attempt
  }
  if (latest === undefined) {
    return 'pipeline-land-commit'
  }
  if (latest.state !== 'settled') {
    return null
  }
  const effect = getAttemptResolution(input.ledger, latest.attemptId)?.effect ?? latest.effect
  if (effect !== 'landed') {
    return latest.action.kind === 'pipeline-land-commit'
      ? 'pipeline-land-commit'
      : latest.action.kind === 'pipeline-land-push'
        ? 'pipeline-land-push'
        : 'pipeline-land-open-review'
  }
  if (latest.action.kind === 'pipeline-land-commit') {
    return 'pipeline-land-push'
  }
  return latest.action.kind === 'pipeline-land-push' ? 'pipeline-land-open-review' : null
}

/** Projects only a current, unresolved approval scope attached to this exact node attempt. */
export function pipelineApprovalForNode(input: {
  escalations: readonly EscalationEntry[]
  attempts: readonly AttemptEntry[]
  ledger: WatcherLedger
  identity: PipelineAttemptIdentity
  contentIdentity: string
  node: PipelineNode
  state: PipelineNodeRunState
}): PipelineNodeApproval | undefined {
  const currentLandActionKind =
    input.node.type === 'land' ? pipelineCurrentLandActionKind(input) : undefined
  for (let index = input.escalations.length - 1; index >= 0; index -= 1) {
    const escalation = input.escalations[index]
    const scope = escalation?.approvalScope
    if (
      !escalation ||
      (escalation.status !== 'open' && escalation.status !== 'escalated') ||
      escalation.escalationKind !== 'awaiting-approval' ||
      !scope ||
      scope.contentIdentity !== input.contentIdentity ||
      getLatestApproval(input.ledger, scope) !== null
    ) {
      continue
    }
    const key = parsePipelineNodeEvidenceKey(scope.evidenceKey)
    if (
      key?.instanceId !== input.identity.instanceId ||
      key.epoch !== input.identity.epoch ||
      key.attempt !== input.identity.attempt
    ) {
      continue
    }
    const waitingFor = pipelineActionWaitFor({
      node: input.node,
      instanceId: input.identity.instanceId,
      scope,
      key
    })
    if (
      waitingFor === null ||
      (waitingFor === 'gate' && input.state.status !== 'ready') ||
      (waitingFor === 'choice' &&
        input.state.status !== 'ready' &&
        input.state.status !== 'waiting' &&
        input.state.status !== 'failed') ||
      (waitingFor === 'capability-approval' && input.state.status !== 'ready') ||
      (waitingFor === 'capability-approval' &&
        input.node.type === 'land' &&
        currentLandActionKind !== scope.actionKind)
    ) {
      continue
    }
    return { escalationId: escalation.escalationId, waitingFor }
  }
  return undefined
}

/** Builds dispatch navigation from the current worker observations. */
export function pipelineWorkerNavigationIndex(
  workers: readonly WatcherWorker[] = []
): PipelineWorkerNavigationIndex {
  const byDispatchId = new Map<string, WatcherWorkerNavigation>()
  let latestNavigation: WatcherWorkerNavigation | undefined
  let latestDispatchedAtMs = -1
  for (const worker of workers) {
    const navigation = worker.navigation
    if (
      navigation === null ||
      navigation === undefined ||
      (worker.liveness !== 'live' && worker.liveness !== 'unverifiable')
    ) {
      continue
    }
    byDispatchId.set(worker.dispatchId, navigation)
    if (worker.dispatchedAtMs > latestDispatchedAtMs) {
      latestNavigation = navigation
      latestDispatchedAtMs = worker.dispatchedAtMs
    }
  }
  return { byDispatchId, latest: latestNavigation }
}

/** Associates an authored node or its private Merge resolver with current worker navigation. */
export function pipelineNodeWorkerNavigation(input: {
  instanceId: string
  nodeId: string
  nodeType: string | undefined
  epoch: number
  attempt: number
  facts: PipelineStoreFacts
  attempts: readonly AttemptEntry[]
  workerNavigation: PipelineWorkerNavigationIndex
  mergeResolvers: PipelineMergeResolverDispatchIndex
}): WatcherWorkerNavigation | undefined {
  const dispatch = input.facts.dispatches.find(
    (row) =>
      row.instanceId === input.instanceId &&
      row.epoch === input.epoch &&
      row.attempt === input.attempt
  )
  const attempt = pipelineLatestAttempt(
    input.attempts,
    input.instanceId,
    input.epoch,
    input.attempt
  )
  const dispatchId = dispatch?.dispatchId ?? attempt?.dispatchId
  const resolverNodeId =
    dispatchId === undefined ? undefined : input.mergeResolvers.byDispatchId.get(dispatchId)
  let selected =
    dispatchId === undefined || (resolverNodeId !== undefined && resolverNodeId !== input.nodeId)
      ? undefined
      : input.workerNavigation.byDispatchId.get(dispatchId)
  let selectedAtMs = selected === undefined ? -1 : (dispatch?.dispatchedAtMs ?? attempt?.atMs ?? -1)
  if (input.nodeType === 'merge') {
    for (const resolver of input.mergeResolvers.byNodeId.get(input.nodeId) ?? []) {
      if (
        resolver.epoch !== input.epoch ||
        input.mergeResolvers.byDispatchId.get(resolver.dispatchId) !== input.nodeId ||
        resolver.startedAtMs < selectedAtMs
      ) {
        continue
      }
      const navigation = input.workerNavigation.byDispatchId.get(resolver.dispatchId)
      if (navigation) {
        selected = navigation
        selectedAtMs = resolver.startedAtMs
      }
    }
  }
  return selected
}
