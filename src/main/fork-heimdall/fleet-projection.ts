import { HEIMDALL_PARALLEL_EXECUTION_UNSUPPORTED_NOTE } from '../../shared/fork-heimdall/capability'
import type { WatcherFleetEntry } from '../../shared/fork-heimdall/fleet-types'
import type {
  HeimdallFleetSnapshotReader,
  WatcherDetailReader,
  WatcherFleetEntryReader
} from '../../shared/fork-heimdall/remote-reader-schemas'
import { isWatcherTickErrorStatus } from '../../shared/fork-heimdall/watcher-tick-error'
import type { FleetEnvironmentIdentity } from './fleet-environment-transport'

export type HeimdallCommandSupport = 'supported' | 'unsupported' | 'unknown'

export const HEIMDALL_OWNER_UNREACHABLE_DETAIL =
  'The owning runtime cannot be reached. This is the last confirmed state.'
export const HEIMDALL_COMMANDS_UNSUPPORTED_DETAIL =
  'The owning runtime does not support Heimdall commands. Update the host to enable controls.'
export const HEIMDALL_COMMANDS_UNVERIFIED_DETAIL =
  'Heimdall command support could not be verified. This watcher is read-only.'

export type RemoteFleetProjection = {
  identity: FleetEnvironmentIdentity
  reachable: boolean
  commandSupport: HeimdallCommandSupport
  parallelExecutionSupport: HeimdallCommandSupport
}

export function routeRemoteFleetEntry(
  entry: WatcherFleetEntryReader,
  identity: FleetEnvironmentIdentity
): WatcherFleetEntryReader {
  if (entry.target.connectionId !== null || entry.target.pairingRevision !== null) {
    throw new Error('A Heimdall owner published a non-local fleet target')
  }
  return {
    ...entry,
    target: {
      watcherId: entry.target.watcherId,
      connectionId: identity.id,
      pairingRevision: identity.pairingRevision
    }
  }
}

export function projectRemoteFleetEntry(
  entry: WatcherFleetEntryReader,
  projection: RemoteFleetProjection
): WatcherFleetEntryReader {
  const targetsCurrentPairing =
    entry.target.connectionId === projection.identity.id &&
    entry.target.pairingRevision === projection.identity.pairingRevision
  const ownerReachable = projection.reachable && targetsCurrentPairing
  const readOnlyReason = !ownerReachable
    ? HEIMDALL_OWNER_UNREACHABLE_DETAIL
    : entry.entry.enrollment.kind === 'unknown'
      ? 'This watcher kind is not supported by this Orca version.'
      : projection.commandSupport === 'unsupported'
        ? HEIMDALL_COMMANDS_UNSUPPORTED_DETAIL
        : projection.commandSupport === 'unknown'
          ? HEIMDALL_COMMANDS_UNVERIFIED_DETAIL
          : entry.readOnlyReason
  const capabilityNotes =
    entry.entry.enrollment.kind === 'objective' &&
    projection.parallelExecutionSupport === 'unsupported' &&
    !entry.capabilityNotes.includes(HEIMDALL_PARALLEL_EXECUTION_UNSUPPORTED_NOTE)
      ? [...entry.capabilityNotes, HEIMDALL_PARALLEL_EXECUTION_UNSUPPORTED_NOTE]
      : entry.capabilityNotes
  const contact = ownerReachable ? entry.contact : 'unverifiable'
  if (entry.entry.enrollment.kind === 'pipeline') {
    const { parallel: _parallel, ...pipelineEntry } = entry
    return {
      ...pipelineEntry,
      contact,
      readOnlyReason,
      capabilityNotes,
      workflowPhase: entry.entry.status.phase
    }
  }
  return { ...entry, contact, readOnlyReason, capabilityNotes }
}

export function routeRemoteDetail(
  detail: WatcherDetailReader,
  routedWatcher: WatcherFleetEntryReader
): WatcherDetailReader {
  if (
    detail.watcher.target.connectionId !== null ||
    detail.watcher.target.pairingRevision !== null ||
    detail.watcher.target.watcherId !== routedWatcher.target.watcherId
  ) {
    throw new Error('A Heimdall owner published detail for a non-local target')
  }
  return { ...detail, watcher: routedWatcher }
}

function attentionRank(entry: WatcherFleetEntryReader): number {
  if (
    entry.contact === 'unverifiable' ||
    entry.entry.status.state === 'unreachable' ||
    isWatcherTickErrorStatus(entry.entry.status)
  ) {
    return 0
  }
  if (entry.entry.status.state === 'escalated') {
    return 1
  }
  if (entry.entry.status.state === 'parked') {
    return 2
  }
  if (
    entry.entry.status.state === 'held' &&
    (entry.entry.status.reason === 'awaiting-approval' ||
      entry.entry.status.parkReason?.kind === 'worker-question')
  ) {
    return 3
  }
  if (entry.entry.status.state === 'acting') {
    return 4
  }
  if (entry.entry.status.state === 'held') {
    return 5
  }
  if (entry.entry.status.state === 'watching') {
    return 6
  }
  return 7
}

export function sortFleetEntries(entries: WatcherFleetEntryReader[]): WatcherFleetEntryReader[] {
  return entries.sort((left, right) => {
    const attention = attentionRank(left) - attentionRank(right)
    if (attention !== 0) {
      return attention
    }
    const byName = left.entry.name.localeCompare(right.entry.name)
    if (byName !== 0) {
      return byName
    }
    const byConnection = (left.target.connectionId ?? '').localeCompare(
      right.target.connectionId ?? ''
    )
    return byConnection !== 0
      ? byConnection
      : left.target.watcherId.localeCompare(right.target.watcherId)
  })
}

export function buildFleetSnapshot(
  localEntries: readonly WatcherFleetEntry[],
  remoteEntries: Iterable<WatcherFleetEntryReader>,
  generatedAtMs: number
): HeimdallFleetSnapshotReader {
  const entries: WatcherFleetEntryReader[] = [...localEntries, ...remoteEntries]
  return { entries: sortFleetEntries(entries), generatedAtMs }
}
