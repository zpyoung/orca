import { join } from 'node:path'
import { z } from 'zod'
import type {
  ActionOutcome,
  EffectCertaintyResolution
} from '../../shared/fork-heimdall/effect-certainty'
import type { GateVerdict } from '../../shared/fork-heimdall/gate'
import type {
  ExecuteContext,
  KernelAction,
  LeaseGuard,
  OwnerInterventionRejection,
  OwnerStateBrief,
  PreflightContext,
  SubmissionPreflightResult,
  WatcherKind,
  WorkerReportSubmission
} from '../../shared/fork-heimdall/kind-contract'
import type { AttemptEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { Deviation } from '../../shared/fork-heimdall/owner/deviation'
import type { Intervention } from '../../shared/fork-heimdall/owner/intervention'
import type { LiveSnapshot, Snapshot } from '../../shared/fork-heimdall/snapshot'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import type { PipelineEnrollmentPayload } from '../../shared/fork-heimdall-pipeline/enrollment-payload'
import {
  PipelineEnrollmentPayloadSchema,
  PipelineEnrollmentRequestSchema
} from '../../shared/fork-heimdall-pipeline/enrollment-payload'
import type { NodeType, PipelineNode } from '../../shared/fork-heimdall-pipeline/document-schema'
import {
  decidePipelineTick,
  derivePipelineRunState,
  pipelineStopVerdict
} from '../../shared/fork-heimdall-pipeline/interpreter'
import { pipelineNodeIdentity } from '../../shared/fork-heimdall-pipeline/interpreter/node-instance'
import { describeScriptApproval } from '../../shared/fork-heimdall-pipeline/script-env'
import { HEIMDALL_ACTIVE_POLL_MS, HEIMDALL_IDLE_POLL_MS } from '../../shared/fork-heimdall/pacing'
import type { PacingTier } from '../../shared/fork-heimdall/pacing'
import type { StopPredicate } from '../../shared/fork-heimdall/stop-policy'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { PipelineStore } from './pipeline-store'
import { createPipelineActionDispatcher } from './pipeline-action-dispatch'
import type { PipelineActionDispatcher } from './pipeline-action-dispatch'
import { createPipelineOwnerAdapter } from './owner-adapter'
import { createPipelineConcurrencyPolicy } from './pipeline-concurrency-policy'
import {
  authorizePipelineEnrollment,
  HOST_PIPELINE_NODE_TYPES,
  validatePipelineEnrollmentRearm
} from './pipeline-kind-authorize'
import { isPipelineInvalidConfigurationWorld, readPipelineKindSnapshot } from './pipeline-kind-read'
import { readPipelineMergeSources } from './pipeline-merge-source-reader'
import type {
  PipelineCompositeReader,
  PipelineKindReadDependencies,
  PipelineKindWorld
} from './pipeline-kind-read'

import { captureTerminalRunNodeStates } from './terminal-run-node-state'

export type PipelineCompositeActionAdapter = Readonly<{
  attemptExpectation?(
    action: KernelAction,
    snapshot: Snapshot<PipelineKindWorld>
  ): { expectedBefore: string; expectedAfter: string } | undefined
  handles(action: KernelAction): boolean
  preflight?(
    action: KernelAction,
    snapshot: Snapshot<PipelineKindWorld>,
    ledger: WatcherLedger,
    context: PreflightContext
  ): Promise<GateVerdict>
  execute(action: KernelAction, context: ExecuteContext<PipelineKindWorld>): Promise<ActionOutcome>
  resolveOutcome(
    attempt: AttemptEntry,
    fresh: LiveSnapshot<PipelineKindWorld>,
    ledger: WatcherLedger,
    lease: LeaseGuard
  ): EffectCertaintyResolution | Promise<EffectCertaintyResolution>
  preflightSubmission?(
    submission: WorkerReportSubmission,
    context: {
      enrollment: WatcherEnrollment
      snapshot: Snapshot<PipelineKindWorld> | null
      ledger: WatcherLedger
    }
  ): Promise<SubmissionPreflightResult>
}>

export type PipelineCompositeOwnerContext = Readonly<{
  nodeInstanceId: string
  epoch: number
  innerSnapshot: Snapshot<unknown>
  scopedLedger: WatcherLedger
  enrollment: WatcherEnrollment
}>

export type PipelineCompositeOwnerDelegate = Readonly<{
  interventionSchema: z.ZodType<Intervention>
  isSitterIntervention(intervention: Intervention): boolean
  describeInterventions(): string
  describeState(
    input: PipelineCompositeOwnerContext & { maxBytes: number; deviation: Deviation }
  ): OwnerStateBrief
  rejectIntervention(
    intervention: Intervention,
    context: PipelineCompositeOwnerContext
  ): OwnerInterventionRejection | null
  actionForIntervention(
    intervention: Intervention,
    context: PipelineCompositeOwnerContext
  ): KernelAction
}>

export type PipelineKindDependencies = Readonly<{
  runtime: OrcaRuntimeService
  store: Store
  pipelineStore: PipelineStore
  storageAuthority: 'desktop' | 'runtime'
  hostNodeTypes?: ReadonlySet<NodeType>
  nowMs?: () => number
  readComposites: PipelineCompositeReader
  compositeActions: PipelineCompositeActionAdapter
  compositeOwner: PipelineCompositeOwnerDelegate
}>

export type PipelineKind = WatcherKind<
  PipelineKindWorld,
  KernelAction,
  PipelineEnrollmentPayload
> & { id: 'pipeline' }
type PipelineStopId = 'pipeline-complete' | 'pipeline-aborted' | 'pipeline-configuration-error'

type PipelineStopResult = { id: PipelineStopId; detail?: string } | null

function deriveWorldRunState(world: PipelineKindWorld, ledger: WatcherLedger) {
  if (isPipelineInvalidConfigurationWorld(world)) {
    return null
  }
  return derivePipelineRunState({
    payload: world.payload,
    ledger,
    facts: world.facts,
    nowMs: world.nowMs,
    hasOwner: world.hasOwner,
    unverifiableDispatchIds: world.unverifiableDispatchIds,
    composites: world.composites
  })
}

function directGateReportSummary(world: PipelineKindWorld, gateId: string): string | null {
  if (isPipelineInvalidConfigurationWorld(world)) {
    return null
  }
  const gate = world.payload.document.nodes.find(
    (node): node is Extract<PipelineNode, { type: 'gate' }> =>
      node.id === gateId && node.type === 'gate'
  )
  if (gate === undefined) {
    return null
  }
  const upstreamIds =
    gate.after
      ?.map((edge) => (typeof edge === 'string' ? edge : edge.node))
      .filter((nodeId) =>
        world.payload.document.nodes.some((node) => node.id === nodeId && node.type === 'agent')
      ) ?? []
  if (upstreamIds.length !== 1) {
    return null
  }
  const upstreamId = upstreamIds[0]
  if (upstreamId === undefined) {
    return null
  }
  const state = deriveWorldRunState(world, world.ledger)
  const upstream = state?.nodes.get(upstreamId)
  if (upstream === undefined) {
    return null
  }
  let summary: string | null = null
  for (const output of world.facts.outputs) {
    if (
      output.instanceId === upstreamId &&
      output.epoch === upstream.epoch &&
      output.attempt === upstream.attempt &&
      typeof output.reportSummary === 'string'
    ) {
      summary = output.reportSummary
    }
  }
  return summary === null ? null : summary.slice(0, 400)
}

function describePipelineApproval(
  snapshot: Snapshot<PipelineKindWorld>,
  action: KernelAction
): string | null {
  const world = snapshot.world
  if (isPipelineInvalidConfigurationWorld(world)) {
    return null
  }
  if (action.kind === 'pipeline-run-script') {
    if (typeof action.command !== 'string') {
      return 'Invalid Script approval data'
    }
    const environment = z.record(z.string(), z.string()).safeParse(action.env)
    return environment.success
      ? describeScriptApproval({ command: action.command, env: environment.data })
      : 'Invalid Script approval data'
  }
  const identity = pipelineNodeIdentity(action)
  const isHumanGate =
    action.kind === 'pipeline-pass-gate' ||
    (action.kind === 'pipeline-apply-choice' && action.cause === 'gate')
  if (!isHumanGate || identity === null) {
    return null
  }
  const gate = world.payload.document.nodes.find(
    (node): node is Extract<PipelineNode, { type: 'gate' }> =>
      node.id === identity.nodeId && node.type === 'gate'
  )
  if (gate === undefined) {
    return null
  }
  const summary = directGateReportSummary(world, gate.id)
  return `${gate.label}\n${summary ?? 'Upstream Agent report summary is unavailable.'}`
}

function describePipelineSnapshot(snapshot: Snapshot<PipelineKindWorld>): Record<string, unknown> {
  const world = snapshot.world
  if (isPipelineInvalidConfigurationWorld(world)) {
    return {
      nodeCountsByStatus: {},
      activeNodeIds: [],
      configurationError: world.invalidConfiguration.field,
      detail: world.invalidConfiguration.detail
    }
  }
  const state = deriveWorldRunState(world, world.ledger)
  if (state === null) {
    return { nodeCountsByStatus: {}, activeNodeIds: [] }
  }
  const nodeCountsByStatus: Record<string, number> = {}
  const activeNodeIds: string[] = []
  for (const [nodeId, nodeState] of state.nodes) {
    nodeCountsByStatus[nodeState.status] = (nodeCountsByStatus[nodeState.status] ?? 0) + 1
    if (nodeState.status !== 'done' && nodeState.status !== 'skipped') {
      activeNodeIds.push(nodeId)
    }
  }
  return { nodeCountsByStatus, activeNodeIds, terminal: state.terminal }
}

function pacePipeline(snapshot: Snapshot<PipelineKindWorld>, ledger: WatcherLedger): PacingTier {
  const world = snapshot.world
  if (isPipelineInvalidConfigurationWorld(world)) {
    return 'stopped'
  }
  const state = deriveWorldRunState(world, ledger)
  if (state === null || state.terminal !== null) {
    return 'stopped'
  }
  if (state.deadlines.some((deadline) => deadline.atMs <= world.nowMs + HEIMDALL_ACTIVE_POLL_MS)) {
    return 'rapid'
  }
  if (
    [...state.nodes.values()].some(
      (node) => node.status === 'running' || node.status === 'unverifiable'
    ) ||
    state.deadlines.some((deadline) => deadline.atMs <= world.nowMs + HEIMDALL_IDLE_POLL_MS)
  ) {
    return 'active'
  }
  return 'idle'
}

function stopResult(
  snapshot: Snapshot<PipelineKindWorld>,
  ledger: WatcherLedger
): PipelineStopResult {
  const world = snapshot.world
  if (isPipelineInvalidConfigurationWorld(world)) {
    return {
      id: 'pipeline-configuration-error',
      detail: `${world.invalidConfiguration.field}: ${world.invalidConfiguration.detail}`
    }
  }
  return pipelineStopVerdict(world, ledger)
}

function evaluateStop(id: PipelineStopId, result: PipelineStopResult) {
  return result?.id === id
    ? {
        stop: true as const,
        reason: result.id,
        ...(result.detail === undefined ? {} : { detail: result.detail })
      }
    : { stop: false as const }
}

/** Assembles the custom pipeline watcher over the shared pure interpreter and host executors. */
export function createPipelineKind(dependencies: PipelineKindDependencies): PipelineKind {
  const nowMs = dependencies.nowMs ?? Date.now
  const dispatcher: PipelineActionDispatcher = createPipelineActionDispatcher({
    runtime: dependencies.runtime,
    store: dependencies.store,
    pipelineStore: dependencies.pipelineStore,
    nowMs,
    compositeActions: dependencies.compositeActions
  })
  const readDependencies: PipelineKindReadDependencies = {
    runtime: dependencies.runtime,
    pipelineStore: dependencies.pipelineStore,
    hostNodeTypes: dependencies.hostNodeTypes ?? HOST_PIPELINE_NODE_TYPES,
    nowMs,
    readComposites: dependencies.readComposites,
    readMergeSources: (input) =>
      readPipelineMergeSources(
        { runtime: dependencies.runtime, pipelineStore: dependencies.pipelineStore },
        input
      )
  }
  const concurrency = createPipelineConcurrencyPolicy({
    runtime: dependencies.runtime,
    pipelineStore: dependencies.pipelineStore
  })
  const owner = createPipelineOwnerAdapter({
    compositeOwner: dependencies.compositeOwner
  })
  const stopCache = new WeakMap<
    Snapshot<PipelineKindWorld>,
    WeakMap<WatcherLedger, PipelineStopResult>
  >()
  const cachedStopResult = (
    snapshot: Snapshot<PipelineKindWorld>,
    ledger: WatcherLedger
  ): PipelineStopResult => {
    let byLedger = stopCache.get(snapshot)
    if (byLedger?.has(ledger)) {
      return byLedger.get(ledger) ?? null
    }
    if (byLedger === undefined) {
      byLedger = new WeakMap()
      stopCache.set(snapshot, byLedger)
    }
    const result = stopResult(snapshot, ledger)
    byLedger.set(ledger, result)
    return result
  }
  const evaluate =
    (id: PipelineStopId) => (snapshot: Snapshot<PipelineKindWorld>, ledger: WatcherLedger) =>
      evaluateStop(id, cachedStopResult(snapshot, ledger))
  const stopPredicates: readonly StopPredicate<PipelineKindWorld>[] = [
    {
      id: 'pipeline-complete',
      disposition: 'terminal',
      evaluate: evaluate('pipeline-complete')
    },
    {
      id: 'pipeline-aborted',
      disposition: 'terminal',
      evaluate: evaluate('pipeline-aborted')
    },
    {
      id: 'pipeline-configuration-error',
      disposition: 'park',
      evaluate: evaluate('pipeline-configuration-error')
    }
  ]
  return {
    id: 'pipeline',
    displayName: 'Pipeline',
    describeEnrollment(enrollment) {
      const payload = PipelineEnrollmentPayloadSchema.safeParse(enrollment.kindPayload)
      return payload.success
        ? `${payload.data.document.name} (${payload.data.pin.id})`
        : 'Pipeline configuration error'
    },
    enrollmentPayloadSchema: PipelineEnrollmentPayloadSchema,
    enrollmentInputSchema: PipelineEnrollmentRequestSchema,
    async authorizeEnrollment(input, scope) {
      return await authorizePipelineEnrollment(
        {
          runtime: dependencies.runtime,
          store: dependencies.store,
          storageAuthority: dependencies.storageAuthority,
          ...(dependencies.hostNodeTypes === undefined
            ? {}
            : { hostNodeTypes: dependencies.hostNodeTypes })
        },
        input,
        scope
      )
    },
    validateEnrollment: validatePipelineEnrollmentRearm,
    purge(watcherId) {
      dependencies.pipelineStore.purge(watcherId)
    },
    async read(enrollment, options) {
      return await readPipelineKindSnapshot(readDependencies, enrollment, options)
    },
    resolveAcceptedWorkerCompletion: dispatcher.resolveAcceptedWorkerCompletion,
    persistTerminalProjection(snapshot, ledger) {
      const world = snapshot.world
      if (isPipelineInvalidConfigurationWorld(world)) {
        return
      }
      const state = deriveWorldRunState(world, ledger)
      if (state === null) {
        return
      }
      dependencies.pipelineStore.recordTerminalNodeStates(
        world.watcherId,
        captureTerminalRunNodeStates(world, ledger, state)
      )
    },
    describeSnapshot: describePipelineSnapshot,
    decide(snapshot, ledger) {
      if (isPipelineInvalidConfigurationWorld(snapshot.world)) {
        return {
          action: null,
          reason: 'pipeline-configuration-error',
          detail: snapshot.world.invalidConfiguration.field,
          considered: []
        }
      }
      return decidePipelineTick(snapshot.world, ledger)
    },
    preflight(action, snapshot, ledger, context) {
      return dispatcher.preflight(action, snapshot, ledger, context)
    },
    execute(action, context) {
      return dispatcher.execute(action, context)
    },
    resolveOutcome(attempt, fresh, ledger, lease) {
      return dispatcher.resolveOutcome(attempt, fresh, ledger, lease)
    },
    attemptExpectation(action, snapshot) {
      return dispatcher.attemptExpectation?.(action, snapshot)
    },
    concurrency,
    stopPredicates,
    pacing: { pace: pacePipeline },
    owner,
    describeApproval: describePipelineApproval,
    submission: dispatcher.submission,
    debug: {
      pointers() {
        return [
          {
            role: 'kind-database',
            host: 'kernel',
            path: join(
              dependencies.store.getProfileStorageDirectory(),
              'fork-heimdall-pipeline',
              'pipeline.db'
            ),
            status: 'resolved'
          }
        ]
      }
    }
  } satisfies PipelineKind
}
