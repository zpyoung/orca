import {
  HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY,
  HEIMDALL_WATCHER_PARK_REASON_V2_RUNTIME_CAPABILITY
} from '../../../../../shared/fork-heimdall/capability'
import type {
  HeimdallFleetSnapshot,
  WatcherDetail,
  WatcherFleetEntry
} from '../../../../../shared/fork-heimdall/fleet-types'
import { ObjectiveEnrollmentPayloadSchema } from '../../../../../shared/fork-heimdall-objective/contract-types'
import type { ObjectiveDetail } from '../../../../../shared/fork-heimdall-objective/detail-types'
import type {
  WatcherListEntry,
  WatcherParkReason,
  WatcherStatus
} from '../../../../../shared/fork-heimdall/watcher-types'
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

function degradeListEntry(entry: WatcherListEntry): WatcherListEntry {
  const status = degradeStatus(entry.status)
  return status === entry.status ? entry : { ...entry, status }
}

function degradeFleetEntry(entry: WatcherFleetEntry): WatcherFleetEntry {
  const listEntry = degradeListEntry(entry.entry)
  return listEntry === entry.entry ? entry : { ...entry, entry: listEntry }
}

function degradeParallelListEntry(entry: WatcherListEntry): WatcherListEntry {
  const { enrollment } = entry
  if (enrollment.kind !== 'objective') {
    return entry
  }
  const parsed = ObjectiveEnrollmentPayloadSchema.safeParse(enrollment.kindPayload)
  if (!parsed.success || parsed.data.lanesEnabled === undefined) {
    return entry
  }
  const { lanesEnabled: _lanesEnabled, ...kindPayload } = parsed.data
  return { ...entry, enrollment: { ...enrollment, kindPayload } }
}

function degradeParallelFleetEntry(entry: WatcherFleetEntry): WatcherFleetEntry {
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
): WatcherListEntry {
  const projected = negotiatedTypedParkReason(context) ? entry : degradeListEntry(entry)
  return negotiatedParallelExecution(context) ? projected : degradeParallelListEntry(projected)
}

export function projectHeimdallFleetSnapshotForClient(
  snapshot: HeimdallFleetSnapshot,
  context: HeimdallWireProjectionContext
): HeimdallFleetSnapshot {
  const typedParkReason = negotiatedTypedParkReason(context)
  const parallelExecution = negotiatedParallelExecution(context)
  if (typedParkReason && parallelExecution) {
    return snapshot
  }
  const entries = snapshot.entries.map((entry) => {
    const projected = typedParkReason ? entry : degradeFleetEntry(entry)
    return parallelExecution ? projected : degradeParallelFleetEntry(projected)
  })
  return entries.some((entry, index) => entry !== snapshot.entries[index])
    ? { ...snapshot, entries }
    : snapshot
}

export function projectHeimdallDetailParkReasonForClient(
  detail: WatcherDetail,
  context: HeimdallWireProjectionContext
): WatcherDetail {
  const projected = negotiatedTypedParkReason(context)
    ? detail.watcher
    : degradeFleetEntry(detail.watcher)
  const watcher = negotiatedParallelExecution(context)
    ? projected
    : degradeParallelFleetEntry(projected)
  return watcher === detail.watcher ? detail : { ...detail, watcher }
}

export function projectObjectiveDetailParallelForClient(
  detail: ObjectiveDetail,
  context: HeimdallWireProjectionContext
): ObjectiveDetail {
  if (negotiatedParallelExecution(context)) {
    return detail
  }
  const { lanesEnabled: _lanesEnabled, ...contract } = detail.contract
  const nodes = detail.nodes.map((node) => {
    if (node.laneTaskKeys === undefined) {
      return node
    }
    const { laneTaskKeys: _laneTaskKeys, ...legacyNode } = node
    return legacyNode
  })
  if (detail.parallel === undefined) {
    return { ...detail, contract, nodes }
  }
  const { parallel: _parallel, ...legacyDetail } = detail
  return { ...legacyDetail, contract, nodes }
}
