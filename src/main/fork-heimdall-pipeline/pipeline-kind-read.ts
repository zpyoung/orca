import { z } from 'zod'
import type { PipelineLandingFacts } from '../../shared/fork-heimdall-pipeline/interpreter/action-envelope'
import type {
  PipelineComposite,
  PipelineMergeSourceFacts,
  PipelineWorld
} from '../../shared/fork-heimdall-pipeline/interpreter'
import type { PipelineStoreFacts } from '../../shared/fork-heimdall-pipeline/store-facts'
import type { PipelineEnrollmentPayload } from '../../shared/fork-heimdall-pipeline/enrollment-payload'
import { PipelineEnrollmentPayloadSchema } from '../../shared/fork-heimdall-pipeline/enrollment-payload'
import { PipelinePinSchema } from '../../shared/fork-heimdall-pipeline/pipeline-pin'
import { pipelineContentHash } from '../../shared/fork-heimdall-pipeline/pipeline-canonical-hash'
import { parsePipelineText } from '../../shared/fork-heimdall-pipeline/pipeline-parse'
import {
  PIPELINE_CAPABILITY_KEYS,
  type NodeType
} from '../../shared/fork-heimdall-pipeline/document-schema'
import { routeEnrollmentKind } from '../../shared/fork-heimdall-pipeline/enrollment-routing'
import { validatePipeline } from '../../shared/fork-heimdall-pipeline/pipeline-validate'
import { getInFlightAttempts } from '../../shared/fork-heimdall/ledger-queries'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import { requireHeimdallKernel } from '../runtime/rpc/methods/fork-heimdall/kernel-binding'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { PipelineStore } from './pipeline-store'
import type { ObjectiveWorkspaceTarget } from '../fork-heimdall-objective/content-identity'
import { resolveObjectiveWorkspaceTarget } from '../fork-heimdall-objective/workspace-target'
import { readPipelineLandingFacts } from './land-node-executor'
import { CompositeNodeConfigurationError } from './composite-node-host'

export type PipelineInvalidConfigurationWorld = Readonly<{
  watcherId: string
  enrollment: WatcherEnrollment
  ledger: WatcherLedger
  invalidConfiguration: Readonly<{ field: string; detail: string }>
}>

export type PipelineReadyWorld = PipelineWorld &
  Readonly<{
    enrollment: WatcherEnrollment
    ledger: WatcherLedger
    compositeReadErrors?: Readonly<Record<string, string>>
  }>

export type PipelineKindWorld = PipelineReadyWorld | PipelineInvalidConfigurationWorld

export type PipelineCompositeReadInput = Readonly<{
  enrollment: WatcherEnrollment
  payload: PipelineEnrollmentPayload
  facts: PipelineStoreFacts
  ledger: WatcherLedger
  target: ObjectiveWorkspaceTarget
  fresh: boolean
  runContentIdentity: string
}>

export type PipelineCompositeReadResult = Readonly<{
  composites: Readonly<Record<string, PipelineComposite>>
  errors?: Readonly<Record<string, string>>
}>

export type PipelineCompositeReader = (
  input: PipelineCompositeReadInput
) => Promise<PipelineCompositeReadResult>

export type PipelineMergeSourceReadInput = Readonly<{
  enrollment: WatcherEnrollment
  payload: PipelineEnrollmentPayload
  facts: PipelineStoreFacts
  ledger: WatcherLedger
  target: ObjectiveWorkspaceTarget
  nowMs: number
  hasOwner: boolean
  unverifiableDispatchIds: ReadonlySet<string>
  composites: Readonly<Record<string, PipelineComposite>>
}>

export type PipelineMergeSourceReader = (
  input: PipelineMergeSourceReadInput
) => Promise<Readonly<Record<string, PipelineMergeSourceFacts>>>

export type PipelineKindReadDependencies = Readonly<{
  runtime: OrcaRuntimeService
  pipelineStore: PipelineStore
  hostNodeTypes?: ReadonlySet<NodeType>
  nowMs?: () => number
  readComposites: PipelineCompositeReader
  readMergeSources: PipelineMergeSourceReader
}>

export function isPipelineInvalidConfigurationWorld(
  world: PipelineKindWorld
): world is PipelineInvalidConfigurationWorld {
  return 'invalidConfiguration' in world
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
function isPipelineDatabaseContentError(error: unknown): boolean {
  return (
    error instanceof z.ZodError ||
    (error instanceof Error && error.message.startsWith('Pipeline database contains'))
  )
}

function pipelineContentIdentity(
  enrollment: WatcherEnrollment,
  facts?: PipelineStoreFacts
): string {
  const parsedPayloadPin = z
    .object({ pin: PipelinePinSchema })
    .passthrough()
    .safeParse(enrollment.kindPayload)
  const hash = parsedPayloadPin.success
    ? parsedPayloadPin.data.pin.contentHash
    : facts?.pin?.contentHash
  return hash === undefined
    ? `pipeline:configuration-error:${enrollment.watcherId}`
    : `pipeline:${hash}`
}

function invalidSnapshot(args: {
  enrollment: WatcherEnrollment
  contentIdentity: string
  ledger: WatcherLedger
  nowMs: number
  fresh: boolean
  field: string
  detail: string
}): Snapshot<PipelineKindWorld> {
  return {
    freshness: args.fresh ? 'live' : 'cached',
    contentIdentity: args.contentIdentity,
    observedAtMs: args.nowMs,
    world: {
      watcherId: args.enrollment.watcherId,
      enrollment: args.enrollment,
      ledger: args.ledger,
      invalidConfiguration: { field: args.field, detail: args.detail }
    }
  }
}

function unsupportedGrantField(enrollment: WatcherEnrollment): string | null {
  for (const key of Object.keys(enrollment.capabilities)) {
    if (!PIPELINE_CAPABILITY_KEYS.some((supported) => supported === key)) {
      return `capabilities.${key}`
    }
  }
  if (enrollment.capabilities.gate !== 'on') {
    return 'capabilities.gate'
  }
  if (enrollment.capabilities.pipeline !== 'on') {
    return 'capabilities.pipeline'
  }
  return null
}

function pipelineField(path: readonly PropertyKey[]): string {
  return `kindPayload.${path.map(String).join('.')}`
}

function sameStoredSource(payload: PipelineEnrollmentPayload, facts: PipelineStoreFacts): boolean {
  const pin = facts.pin
  return (
    pin !== null &&
    pin.runNumber !== null &&
    pin.ref === payload.pin.ref &&
    pin.scope === payload.pin.scope &&
    pin.id === payload.pin.id &&
    pin.contentHash === payload.pin.contentHash &&
    pin.documentVersion === payload.pin.documentVersion
  )
}

export async function readPipelineKindSnapshot(
  dependencies: PipelineKindReadDependencies,
  enrollment: WatcherEnrollment,
  options: { fresh: boolean }
): Promise<Snapshot<PipelineKindWorld>> {
  if (enrollment.kind !== 'pipeline') {
    throw new Error('Pipeline kind received a different enrollment kind')
  }
  const kernel = requireHeimdallKernel(dependencies.runtime)
  const ledger = kernel.ledger(enrollment.watcherId)
  const nowMs = dependencies.nowMs?.() ?? Date.now()
  let facts: PipelineStoreFacts
  try {
    facts = dependencies.pipelineStore.facts(enrollment.watcherId)
  } catch (error) {
    if (!isPipelineDatabaseContentError(error)) {
      throw error
    }
    return invalidSnapshot({
      enrollment,
      contentIdentity: pipelineContentIdentity(enrollment),
      ledger,
      nowMs,
      fresh: options.fresh,
      field: 'pipeline.db',
      detail: errorDetail(error)
    })
  }
  const contentIdentity = pipelineContentIdentity(enrollment, facts)
  const payloadHeader = z
    .object({ schemaVersion: z.number().int() })
    .passthrough()
    .safeParse(enrollment.kindPayload)
  const invalid = (field: string, detail: string) =>
    invalidSnapshot({
      enrollment,
      contentIdentity,
      ledger,
      nowMs,
      fresh: options.fresh,
      field,
      detail
    })

  if (payloadHeader.success && payloadHeader.data.schemaVersion > 1) {
    return invalid(
      'kindPayload.schemaVersion',
      'This host does not support the saved pipeline schema version'
    )
  }
  const parsedPayload = PipelineEnrollmentPayloadSchema.safeParse(enrollment.kindPayload)
  if (!parsedPayload.success) {
    const first = parsedPayload.error.issues[0]
    return invalid(
      first === undefined ? 'kindPayload' : pipelineField(first.path),
      parsedPayload.error.message
    )
  }
  const payload = parsedPayload.data
  if (!sameStoredSource(payload, facts)) {
    return invalid(
      'kindPayload.pin.contentHash',
      'The stored run pin does not match the saved payload'
    )
  }
  let storedSource
  try {
    storedSource = dependencies.pipelineStore.runSource(enrollment.watcherId)
  } catch (error) {
    if (!(error instanceof z.ZodError)) {
      throw error
    }
    return invalid('pipeline.db.source_text', errorDetail(error))
  }
  if (storedSource === null || storedSource.sourceText !== payload.sourceText) {
    return invalid(
      'kindPayload.sourceText',
      'The saved source does not match its recorded run source'
    )
  }
  const parsedSource = parsePipelineText(payload.sourceText)
  if (
    parsedSource.document === null ||
    pipelineContentHash(parsedSource.document) !== payload.pin.contentHash ||
    pipelineContentHash(payload.document) !== payload.pin.contentHash
  ) {
    return invalid('kindPayload.pin.contentHash', 'The saved source, document and pin do not match')
  }
  if (routeEnrollmentKind(payload.document) !== 'pipeline') {
    return invalid('kindPayload.document', 'The saved document routes to a built-in watcher kind')
  }
  const unsupportedGrant = unsupportedGrantField(enrollment)
  if (unsupportedGrant !== null) {
    return invalid(unsupportedGrant, 'The saved pipeline capability configuration is unsupported')
  }

  const errors = validatePipeline(payload.document, {
    workspaceKind: payload.workspaceKind,
    ...(dependencies.hostNodeTypes === undefined
      ? {}
      : { hostNodeTypes: dependencies.hostNodeTypes }),
    expectedId: payload.pin.id
  })
  if (errors.length > 0) {
    const first = errors[0]
    return invalid(
      first?.path === undefined ? 'kindPayload.document' : pipelineField(first.path),
      JSON.stringify(errors)
    )
  }
  const target = await resolveObjectiveWorkspaceTarget(dependencies.runtime, enrollment)
  if (target.kind !== payload.workspaceKind) {
    return invalid(
      'kindPayload.workspaceKind',
      'The saved workspace kind does not match host workspace identity'
    )
  }
  let composites: Readonly<Record<string, PipelineComposite>> = {}
  const compositeReadErrors: Record<string, string> = {}
  try {
    const compositeRead = await dependencies.readComposites({
      enrollment,
      payload,
      facts,
      ledger,
      target,
      fresh: options.fresh,
      runContentIdentity: `pipeline:${payload.pin.contentHash}`
    })
    composites = compositeRead.composites
    Object.assign(compositeReadErrors, compositeRead.errors ?? {})
  } catch (error) {
    if (!(error instanceof CompositeNodeConfigurationError)) {
      throw error
    }
    compositeReadErrors[error.instanceId] = error.detail
  }

  const activeDispatchIds = new Set(
    getInFlightAttempts(ledger).flatMap((attempt) =>
      (attempt.action.kind === 'pipeline-dispatch-agent' ||
        attempt.action.kind === 'pipeline-resolve-merge-conflict') &&
      attempt.dispatchId !== undefined
        ? [attempt.dispatchId]
        : []
    )
  )
  const unverifiableDispatchIds = new Set<string>()
  if (activeDispatchIds.size > 0) {
    const detail = await kernel.detail({
      watcherId: enrollment.watcherId,
      connectionId: null,
      pairingRevision: null
    })
    for (const worker of detail.workers) {
      if (worker.liveness === 'unverifiable' && activeDispatchIds.has(worker.dispatchId)) {
        unverifiableDispatchIds.add(worker.dispatchId)
      }
    }
    if (
      detail.watcher.entry.status.phase === 'worker-unverifiable' &&
      detail.workers.length === 0
    ) {
      for (const dispatchId of activeDispatchIds) {
        unverifiableDispatchIds.add(dispatchId)
      }
    }
  }

  let landingFacts: PipelineLandingFacts | undefined
  if (payload.document.nodes.some((node) => node.type === 'land')) {
    landingFacts = await readPipelineLandingFacts({ target, repoKey: enrollment.repoId })
  }
  const mergeSources = await dependencies.readMergeSources({
    enrollment,
    target,
    payload,
    facts,
    ledger,
    nowMs,
    hasOwner: enrollment.owner !== undefined,
    unverifiableDispatchIds,
    composites
  })
  const world: PipelineReadyWorld = {
    watcherId: enrollment.watcherId,
    enrollment,
    payload,
    facts,
    ...(Object.keys(mergeSources).length === 0 ? {} : { mergeSources }),
    nowMs,
    hasOwner: enrollment.owner !== undefined,
    grants: enrollment.capabilities,
    workspacePath: enrollment.workspacePath,
    ...(landingFacts === undefined ? {} : { landingFacts }),
    unverifiableDispatchIds,
    composites,
    ...(Object.keys(compositeReadErrors).length === 0 ? {} : { compositeReadErrors }),
    ledger
  }
  return {
    freshness: options.fresh ? 'live' : 'cached',
    contentIdentity,
    observedAtMs: nowMs,
    world
  }
}
