import { useSyncExternalStore } from 'react'
import type { HeimdallApi } from '../../../shared/fork-heimdall/api'
import type {
  WatcherKindId,
  WatcherListEntry,
  WatcherStatusState
} from '../../../shared/fork-heimdall/watcher-types'

const POLL_INTERVAL_MS = 5_000

export type ActiveHeimdallWatcherState = {
  watcherId: string
  kind: WatcherKindId
  state: WatcherStatusState
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

function getListApi(): Pick<HeimdallApi, 'list'> | null {
  const candidate: unknown = window.api?.heimdall
  if (!candidate || typeof candidate !== 'object') {
    return null
  }
  const list = (candidate as Partial<HeimdallApi>).list
  return typeof list === 'function' ? { list } : null
}

let snapshot: ReadonlyMap<string, ActiveHeimdallWatcherState> = new Map()
const subscribers = new Set<() => void>()
let pollHandle: number | null = null

function matchesSnapshot(next: ReadonlyMap<string, ActiveHeimdallWatcherState>): boolean {
  if (next.size !== snapshot.size) {
    return false
  }
  for (const [worktreeId, state] of next) {
    const previous = snapshot.get(worktreeId)
    if (
      previous?.watcherId !== state.watcherId ||
      previous.kind !== state.kind ||
      previous.state !== state.state
    ) {
      return false
    }
  }
  return true
}

async function refresh(): Promise<void> {
  const api = getListApi()
  if (!api) {
    return
  }
  let entries: WatcherListEntry[]
  try {
    entries = await api.list()
  } catch {
    // A bridge failure says nothing about the owner's current state; retain the last observation.
    return
  }
  const next = new Map<string, ActiveHeimdallWatcherState>()
  for (const entry of entries) {
    const worktreeId = entry.enrollment.worktreeId
    if (worktreeId && isActiveHeimdallWatcher(entry)) {
      next.set(worktreeId, {
        watcherId: entry.enrollment.watcherId,
        kind: entry.enrollment.kind,
        state: entry.status.state
      })
    }
  }
  if (matchesSnapshot(next)) {
    return
  }
  snapshot = next
  for (const notify of subscribers) {
    notify()
  }
}

function subscribe(onStoreChange: () => void): () => void {
  subscribers.add(onStoreChange)
  // Preload is installed before React mounts. Avoid a useless interval (and leaked test timer) when
  // this build has no Heimdall bridge.
  if (pollHandle === null && getListApi()) {
    void refresh()
    pollHandle = window.setInterval(() => void refresh(), POLL_INTERVAL_MS)
  }
  return () => {
    subscribers.delete(onStoreChange)
    if (subscribers.size === 0 && pollHandle !== null) {
      window.clearInterval(pollHandle)
      pollHandle = null
    }
  }
}

/** Every worktree card shares this one five-second fleet poll. */
export function useActiveHeimdallWatcherState(
  worktreeId: string
): ActiveHeimdallWatcherState | null {
  return useSyncExternalStore(
    subscribe,
    () => snapshot.get(worktreeId) ?? null,
    () => null
  )
}
