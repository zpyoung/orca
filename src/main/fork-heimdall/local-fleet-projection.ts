import type { WatcherFleetEntry, WatcherOwnerFence } from '../../shared/fork-heimdall/fleet-types'
import type { WatcherListEntry } from '../../shared/fork-heimdall/watcher-types'

const ATTENTION_RANK: Record<WatcherListEntry['status']['state'], number> = {
  escalated: 0,
  parked: 0,
  unreachable: 1,
  held: 2,
  acting: 3,
  watching: 4,
  disabled: 5,
  terminal: 6
}

export function watcherOwnerFence(entry: WatcherListEntry): WatcherOwnerFence {
  const enrollment = entry.enrollment
  return {
    executionHostId: enrollment.executionHostId,
    schedulerOwner: enrollment.schedulerOwner,
    workspaceKey: enrollment.workspaceKey,
    revision: enrollment.commandRevision
  }
}

export function localFleetEntry(
  entry: WatcherListEntry,
  observedAtMs: number,
  owned: boolean
): WatcherFleetEntry {
  const capabilityNotes =
    entry.enrollment.schedulerOwner === 'ssh_bridge'
      ? [
          'SSH control requires this desktop client to stay connected; use a remote runtime for unattended work.'
        ]
      : []
  return {
    target: { watcherId: entry.enrollment.watcherId, connectionId: null, pairingRevision: null },
    entry,
    ownerFence: watcherOwnerFence(entry),
    observedAtMs,
    contact: 'live',
    readOnlyReason: owned ? null : 'This watcher is owned by another runtime.',
    capabilityNotes,
    paused: entry.enrollment.paused
  }
}

export function sortLocalFleetByAttention(entries: WatcherFleetEntry[]): WatcherFleetEntry[] {
  return entries.sort((left, right) => {
    const attention =
      ATTENTION_RANK[left.entry.status.state] - ATTENTION_RANK[right.entry.status.state]
    if (attention !== 0) {
      return attention
    }
    const created = left.entry.enrollment.createdAtMs - right.entry.enrollment.createdAtMs
    return created !== 0
      ? created
      : left.entry.enrollment.watcherId.localeCompare(right.entry.enrollment.watcherId)
  })
}
