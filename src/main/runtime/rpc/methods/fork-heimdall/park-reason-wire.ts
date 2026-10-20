import {
  HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY,
  HEIMDALL_WATCHER_PARK_REASON_V2_RUNTIME_CAPABILITY
} from '../../../../../shared/fork-heimdall/capability'
import type {
  HeimdallFleetSnapshotReader,
  WatcherDetailReader,
  WatcherFleetEntryReader,
  WatcherListEntryReader
} from '../../../../../shared/fork-heimdall/remote-reader-schemas'
import { ObjectiveEnrollmentPayloadSchema } from '../../../../../shared/fork-heimdall-objective/contract-types'
import type { ObjectiveDetail } from '../../../../../shared/fork-heimdall-objective/detail-types'
import type {
  WatcherListEntry,
  WatcherParkReason,
  WatcherStatus
} from '../../../../../shared/fork-heimdall/watcher-types'
import {
  projectPipelineDetailForClient,
  projectPipelineFleetSnapshotForClient
} from './pipeline-kind-wire'
import type { RpcContext } from '../../core'

type HeimdallWireProjectionContext = Pick<RpcContext, 'clientKind' | 'clientCapabilities'>

/**
 * The park-reason kinds that predate `heimdall.watcher-park-reason.v2`, and so are the only ones an
 * un-negotiated reader can parse. Listing the supported kinds rather than the unsupported ones keeps
 * a newly added kind degraded by default: a reader compiled before it exists rejects the whole
 * containing payload on an unknown discriminant, and an allowlist of what to strip would let that
 * kind leak the moment someone forgets to extend it.
 */
const READER_SUPPORTED_PARK_REASON_KINDS = new Set<WatcherParkReason['kind']>([
  'budget',
  'stop-predicate',
  'worker-question',
  'coordinator-seat-lost'
])

function negotiatedTypedParkReason(context: HeimdallWireProjectionContext): boolean {
  return (
    context.clientKind === undefined ||
    context.clientCapabilities?.includes(HEIMDALL_WATCHER_PARK_REASON_V2_RUNTIME_CAPABILITY) ===
      true
  )
}

function negotiatedParallelExecution(context: HeimdallWireProjectionContext): boolean {
  return (
    context.clientKind === undefined ||
    context.clientCapabilities?.includes(HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY) === true
  )
}

function degradeStatus(status: WatcherStatus): WatcherStatus {
  if (!status.parkReason || READER_SUPPORTED_PARK_REASON_KINDS.has(status.parkReason.kind)) {
    return status
  }
  return { ...status, parkReason: null }
}

function degradeListEntry(entry: WatcherListEntryReader): WatcherListEntryReader {
  const status = degradeStatus(entry.status)
  return status === entry.status ? entry : { ...entry, status }
}

function degradeFleetEntry(entry: WatcherFleetEntryReader): WatcherFleetEntryReader {
  const listEntry = degradeListEntry(entry.entry)
  return listEntry === entry.entry ? entry : { ...entry, entry: listEntry }
}

function degradeParallelListEntry(entry: WatcherListEntryReader): WatcherListEntryReader {
  const { enrollment } = entry
  if (enrollment.kind !== 'objective') {
    return entry
  }
  const parsed = ObjectiveEnrollmentPayloadSchema.safeParse(enrollment.kindPayload)
  if (
    !parsed.success ||
    (parsed.data.lanesEnabled === undefined && parsed.data.gates === undefined)
  ) {
    return entry
  }
  const { lanesEnabled: _lanesEnabled, gates: _gates, ...kindPayload } = parsed.data
  return { ...entry, enrollment: { ...enrollment, kindPayload } }
}

function degradeParallelFleetEntry(entry: WatcherFleetEntryReader): WatcherFleetEntryReader {
  const listEntry = degradeParallelListEntry(entry.entry)
  if (entry.parallel === undefined) {
    return listEntry === entry.entry ? entry : { ...entry, entry: listEntry }
  }
  const { parallel: _parallel, ...legacyEntry } = entry
  return listEntry === entry.entry ? legacyEntry : { ...legacyEntry, entry: listEntry }
}

/** Keeps the durable state but hides park reasons an older reader's union cannot decode. */
export function projectWatcherListEntryForClient(
  entry: WatcherListEntry,
  context: HeimdallWireProjectionContext
): WatcherListEntry
export function projectWatcherListEntryForClient(
  entry: WatcherListEntryReader,
  context: HeimdallWireProjectionContext
): WatcherListEntryReader
export function projectWatcherListEntryForClient(
  entry: WatcherListEntryReader,
  context: HeimdallWireProjectionContext
): WatcherListEntryReader {
  const projected = negotiatedTypedParkReason(context) ? entry : degradeListEntry(entry)
  return negotiatedParallelExecution(context) ? projected : degradeParallelListEntry(projected)
}

export function projectHeimdallFleetSnapshotForClient(
  snapshot: HeimdallFleetSnapshotReader,
  context: HeimdallWireProjectionContext
): HeimdallFleetSnapshotReader {
  const pipelineProjected = projectPipelineFleetSnapshotForClient(snapshot, context)
  const typedParkReason = negotiatedTypedParkReason(context)
  const parallelExecution = negotiatedParallelExecution(context)
  if (typedParkReason && parallelExecution) {
    return pipelineProjected
  }
  const entries = pipelineProjected.entries.map((entry) => {
    const projected = typedParkReason ? entry : degradeFleetEntry(entry)
    return parallelExecution ? projected : degradeParallelFleetEntry(projected)
  })
  return entries.some((entry, index) => entry !== pipelineProjected.entries[index])
    ? { ...pipelineProjected, entries }
    : pipelineProjected
}

export function projectHeimdallDetailParkReasonForClient(
  detail: WatcherDetailReader,
  context: HeimdallWireProjectionContext
): WatcherDetailReader {
  const pipelineProjected = projectPipelineDetailForClient(detail, context)
  const projected = negotiatedTypedParkReason(context)
    ? pipelineProjected.watcher
    : degradeFleetEntry(pipelineProjected.watcher)
  const watcher = negotiatedParallelExecution(context)
    ? projected
    : degradeParallelFleetEntry(projected)
  return watcher === detail.watcher ? detail : { ...detail, watcher }
}

function degradeObjectiveDetailNode(
  node: ObjectiveDetail['nodes'][number]
): ObjectiveDetail['nodes'][number] {
  if (
    node.laneTaskKeys === undefined &&
    node.territory === undefined &&
    node.overrunPaths === undefined
  ) {
    return node
  }
  const {
    laneTaskKeys: _laneTaskKeys,
    territory: _territory,
    overrunPaths: _overrunPaths,
    ...legacyNode
  } = node
  return legacyNode
}

export function projectObjectiveDetailParallelForClient(
  detail: ObjectiveDetail,
  context: HeimdallWireProjectionContext
): ObjectiveDetail {
  if (negotiatedParallelExecution(context)) {
    return detail
  }
  const { lanesEnabled: _lanesEnabled, gates: _gates, ...contract } = detail.contract
  const nodes = detail.nodes.map(degradeObjectiveDetailNode)
  const {
    parallel: _parallel,
    planLint: _planLint,
    assumptions: _assumptions,
    planReviews: _planReviews,
    pendingPatch: _pendingPatch,
    gates: _detailGates,
    noGateDeclared: _noGateDeclared,
    ...legacyDetail
  } = detail
  return { ...legacyDetail, contract, nodes }
}
