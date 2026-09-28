import { useMemo } from 'react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
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
  phase: string
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

function indexWorktreeWatchers(
  entries: readonly WatcherFleetEntry[]
): ReadonlyMap<string, WatcherFleetEntry> {
  const selected = new Map<string, WatcherFleetEntry>()
  for (const row of entries) {
    const worktreeId = row.entry.enrollment.worktreeId
    if (
      worktreeId === null ||
      (!isHeimdallAttentionRow(row) && !isActiveHeimdallWatcher(row.entry))
    ) {
      continue
    }
    const current = selected.get(worktreeId)
    if (!current || indicatorPriority(row) < indicatorPriority(current)) {
      selected.set(worktreeId, row)
    }
  }
  return selected
}

type WorktreeWatcherIndex = {
  entries: readonly WatcherFleetEntry[] | undefined
  byWorktree: ReadonlyMap<string, WatcherFleetEntry>
}

// Why a separate store: one app-store listener per sidebar card is O(cards) work on every app
// store notification; this keeps the app store at one listener however many cards mount.
const worktreeWatcherIndex = createStore<WorktreeWatcherIndex>(() => ({
  entries: undefined,
  byWorktree: new Map()
}))
let worktreeWatcherIndexSubscribed = false

function syncWorktreeWatcherIndex(): void {
  const entries = useAppStore.getState().heimdallFleet?.entries
  if (entries === worktreeWatcherIndex.getState().entries) {
    return
  }
  worktreeWatcherIndex.setState({ entries, byWorktree: indexWorktreeWatchers(entries ?? []) })
}

function ensureWorktreeWatcherIndex(): void {
  // Why the method checks: upstream card suites mock useAppStore as a bare selector hook.
  if (
    worktreeWatcherIndexSubscribed ||
    typeof useAppStore.getState !== 'function' ||
    typeof useAppStore.subscribe !== 'function'
  ) {
    return
  }
  worktreeWatcherIndexSubscribed = true
  syncWorktreeWatcherIndex()
  useAppStore.subscribe(syncWorktreeWatcherIndex)
}

/** Worktree indicators consume the same seeded push cache as the fleet page. */
export function useActiveHeimdallWatcherState(
  worktreeId: string
): ActiveHeimdallWatcherState | null {
  ensureWorktreeWatcherIndex()
  const row = useStore(worktreeWatcherIndex, (index) => index.byWorktree.get(worktreeId) ?? null)
  return useMemo(
    () =>
      row
        ? {
            watcherId: row.target.watcherId,
            kind: row.entry.enrollment.kind,
            state: row.entry.status.state,
            phase: row.entry.status.phase,
            contact: row.contact,
            observedAtMs: row.observedAtMs,
            attention: isHeimdallAttentionRow(row)
          }
        : null,
    [row]
  )
}
