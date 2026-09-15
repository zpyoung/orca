import { HEIMDALL_CHANNELS } from '../../shared/fork-heimdall/api'
import {
  WatcherDetailSchema,
  type WatcherDetail,
  type WatcherFleetEntry,
  type WatcherTarget
} from '../../shared/fork-heimdall/fleet-types'
import type { Store } from '../persistence'
import type {
  FleetEnvironmentIdentity,
  FleetEnvironmentTransport
} from './fleet-environment-transport'
import {
  HEIMDALL_OWNER_UNREACHABLE_DETAIL,
  projectRemoteFleetEntry,
  routeRemoteDetail,
  type RemoteFleetProjection
} from './fleet-projection'
import { notifyWatcherDetailTransition, type WatcherNotificationPublication } from './notification'

export class HeimdallOwnerDetailReadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HeimdallOwnerDetailReadError'
  }
}

export async function readConfirmedRemoteDetail(
  environments: FleetEnvironmentTransport,
  identity: FleetEnvironmentIdentity,
  target: WatcherTarget,
  routeWatcher: (owner: WatcherFleetEntry) => WatcherFleetEntry
): Promise<WatcherDetail> {
  const response = await environments.read(identity, HEIMDALL_CHANNELS.detail, {
    watcherId: target.watcherId,
    connectionId: null,
    pairingRevision: null
  })
  if (response.ok !== true) {
    throw new HeimdallOwnerDetailReadError(
      `The owning runtime refused the Heimdall detail read: ${response.error.message}`
    )
  }
  const parsed = WatcherDetailSchema.safeParse(response.result)
  if (!parsed.success) {
    throw new HeimdallOwnerDetailReadError(
      'The owning runtime returned an invalid Heimdall watcher detail.'
    )
  }
  try {
    return routeRemoteDetail(parsed.data, routeWatcher(parsed.data.watcher))
  } catch {
    throw new HeimdallOwnerDetailReadError(
      'The owning runtime returned detail for an invalid Heimdall watcher target.'
    )
  }
}

export function projectRemoteDetail(
  projection: RemoteFleetProjection,
  detail: WatcherDetail
): WatcherDetail {
  const watcher = projectRemoteFleetEntry(detail.watcher, projection)
  if (watcher.contact === 'live') {
    return { ...detail, watcher }
  }
  return {
    ...detail,
    watcher,
    workers: detail.workers.map((worker) =>
      worker.liveness === 'live'
        ? { ...worker, liveness: 'unverifiable', reason: HEIMDALL_OWNER_UNREACHABLE_DETAIL }
        : worker
    )
  }
}

export async function captureRemoteDetailNotifications(args: {
  entries: readonly WatcherFleetEntry[]
  previousEntries: ReadonlyMap<string, WatcherFleetEntry>
  details: Map<string, WatcherDetail>
  publication: WatcherNotificationPublication
  store: Pick<Store, 'getSettings'> | undefined
  readDetail: (target: WatcherTarget) => Promise<WatcherDetail>
  isCurrent: (target: WatcherTarget) => boolean
}): Promise<void> {
  const store = args.store
  if (!store) {
    return
  }
  const candidates =
    args.publication === 'live'
      ? args.entries.filter((next) => {
          const previous =
            args.details.get(detailKey(next.target))?.watcher ??
            args.previousEntries.get(next.target.watcherId)
          return (
            !previous ||
            next.entry.status.state === 'held' ||
            next.entry.status.state === 'escalated' ||
            (previous.entry.status.state !== 'terminal' && next.entry.status.state === 'terminal')
          )
        })
      : args.entries
  await Promise.all(
    candidates.map(async (entry) => {
      const previous = args.details.get(detailKey(entry.target)) ?? null
      try {
        const next = await args.readDetail(entry.target)
        if (!args.isCurrent(entry.target)) {
          return
        }
        notifyWatcherDetailTransition(store, previous, next, args.publication)
        args.details.set(detailKey(entry.target), next)
      } catch {
        // Notification reads are best effort and never create an error notification.
      }
    })
  )
}

function detailKey(target: WatcherTarget): string {
  return `${target.connectionId ?? 'local'}\0${target.pairingRevision ?? 'local'}\0${target.watcherId}`
}
