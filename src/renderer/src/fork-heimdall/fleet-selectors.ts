import { isWatcherTickErrorStatus } from '../../../shared/fork-heimdall/watcher-tick-error'
import type { WatcherFleetEntry, WatcherTarget } from '../../../shared/fork-heimdall/fleet-types'
import type { WatcherStatusState } from '../../../shared/fork-heimdall/watcher-types'

/** Classifies each watcher by the fleet indicator it contributes to. */
export type HeimdallFleetBucket = 'attention' | 'lostContact' | 'active' | 'inactive'

/** Orders the fleet indicators by urgency. */
export const HEIMDALL_FLEET_BUCKET_ORDER: readonly HeimdallFleetBucket[] = [
  'attention',
  'lostContact',
  'active',
  'inactive'
]

const STATE_RANK: Record<WatcherFleetEntry['entry']['status']['state'], number> = {
  escalated: 0,
  parked: 1,
  unreachable: 2,
  held: 3,
  acting: 4,
  watching: 5,
  terminal: 6,
  disabled: 7
}

export function isHeimdallAttentionRow(row: WatcherFleetEntry): boolean {
  const status = row.entry.status
  return (
    status.state === 'escalated' ||
    status.state === 'parked' ||
    (status.state === 'held' &&
      (status.reason === 'awaiting-approval' || status.parkReason?.kind === 'worker-question'))
  )
}

function attentionRank(row: WatcherFleetEntry): number {
  if (isHeimdallAttentionRow(row)) {
    return STATE_RANK[row.entry.status.state]
  }
  if (row.contact === 'unverifiable' || isWatcherTickErrorStatus(row.entry.status)) {
    return STATE_RANK.unreachable
  }
  return STATE_RANK[row.entry.status.state]
}

function bucketForWatcherState(state: WatcherStatusState): HeimdallFleetBucket {
  switch (state) {
    case 'watching':
    case 'acting':
    case 'held':
      return 'active'
    case 'terminal':
    case 'disabled':
      return 'inactive'
    case 'escalated':
    case 'parked':
      return 'attention'
    case 'unreachable':
      return 'lostContact'
  }
  return state satisfies never
}

/** Assigns exactly one bucket to a watcher, preserving urgent signals above inactivity. */
export function heimdallFleetBucket(row: WatcherFleetEntry): HeimdallFleetBucket {
  if (isHeimdallAttentionRow(row)) {
    return 'attention'
  }
  const status = row.entry.status
  if (row.contact === 'unverifiable' || status.state === 'unreachable') {
    return 'lostContact'
  }
  if (row.paused || !status.enabled || (status.state === 'held' && status.reason === 'paused')) {
    return 'inactive'
  }

  return bucketForWatcherState(status.state)
}

/** Counts each watcher once, including buckets with no watchers. */
export function countHeimdallFleetBuckets(
  entries: readonly WatcherFleetEntry[]
): Record<HeimdallFleetBucket, number> {
  const counts: Record<HeimdallFleetBucket, number> = {
    attention: 0,
    lostContact: 0,
    active: 0,
    inactive: 0
  }
  for (const row of entries) {
    counts[heimdallFleetBucket(row)] += 1
  }
  return counts
}

export function sortHeimdallFleetRows(entries: readonly WatcherFleetEntry[]): WatcherFleetEntry[] {
  return [...entries].sort((left, right) => {
    const rankDelta = attentionRank(left) - attentionRank(right)
    if (rankDelta !== 0) {
      return rankDelta
    }
    const tickDelta =
      (right.entry.status.lastSuccessfulTickAtMs ?? -1) -
      (left.entry.status.lastSuccessfulTickAtMs ?? -1)
    return tickDelta || left.entry.name.localeCompare(right.entry.name)
  })
}

export function countHeimdallAttention(entries: readonly WatcherFleetEntry[]): number {
  return entries.reduce((count, row) => count + Number(isHeimdallAttentionRow(row)), 0)
}

export function sameWatcherTarget(left: WatcherTarget | null, right: WatcherTarget): boolean {
  return (
    left?.watcherId === right.watcherId &&
    left.connectionId === right.connectionId &&
    left.pairingRevision === right.pairingRevision
  )
}
