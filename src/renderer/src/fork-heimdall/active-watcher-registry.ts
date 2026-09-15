import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { WatcherFleetEntry } from '../../../shared/fork-heimdall/fleet-types'
import type {
  WatcherKindId,
  WatcherListEntry,
  WatcherStatusState
} from '../../../shared/fork-heimdall/watcher-types'
import { isHeimdallAttentionRow } from './fleet-selectors'

export type ActiveHeimdallWatcherState = {
  watcherId: string
  kind: WatcherKindId
  state: WatcherStatusState
  contact: 'live' | 'unverifiable'
  attention: boolean
  observedAtMs: number
}

/** A watcher still owns its workspace until it is explicitly disabled or terminal. */
export function isActiveHeimdallWatcher(entry: WatcherListEntry): boolean {
  return (
    entry.enrollment.enabled &&
    entry.status.enabled &&
    entry.status.state !== 'terminal' &&
    entry.status.state !== 'disabled'
  )
}

function indicatorPriority(row: WatcherFleetEntry): number {
  if (isHeimdallAttentionRow(row)) {
    return 0
  }
  if (row.contact === 'unverifiable' || row.entry.status.state === 'unreachable') {
    return 1
  }
  return 2
}

function selectWorktreeWatcher(
  entries: readonly WatcherFleetEntry[],
  worktreeId: string
): WatcherFleetEntry | null {
  let selected: WatcherFleetEntry | null = null
  for (const row of entries) {
    const needsAttention = isHeimdallAttentionRow(row)
    if (
      row.entry.enrollment.worktreeId !== worktreeId ||
      (!needsAttention && !isActiveHeimdallWatcher(row.entry))
    ) {
      continue
    }
    if (!selected || indicatorPriority(row) < indicatorPriority(selected)) {
      selected = row
    }
  }
  return selected
}

/** Worktree indicators consume the same seeded push cache as the fleet page. */
export function useActiveHeimdallWatcherState(
  worktreeId: string
): ActiveHeimdallWatcherState | null {
  const row = useAppStore((state) =>
    selectWorktreeWatcher(state.heimdallFleet?.entries ?? [], worktreeId)
  )
  return useMemo(
    () =>
      row
        ? {
            watcherId: row.target.watcherId,
            kind: row.entry.enrollment.kind,
            state: row.entry.status.state,
            contact: row.contact,
            observedAtMs: row.observedAtMs,
            attention: isHeimdallAttentionRow(row)
          }
        : null,
    [row]
  )
}
