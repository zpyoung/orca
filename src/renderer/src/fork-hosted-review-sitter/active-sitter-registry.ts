import { useSyncExternalStore } from 'react'
import type {
  HostedReviewSitterApi,
  HostedReviewSitterListEntry
} from '../../../shared/fork-hosted-review-sitter/api'
import type { HostedReviewSitterStatusState } from '../../../shared/fork-hosted-review-sitter/types'

const POLL_INTERVAL_MS = 5_000

/** A sitter still owns its review: enabled on both sides and not in a terminal lifecycle state. */
export function isActiveHostedReviewSitter(entry: HostedReviewSitterListEntry): boolean {
  return (
    entry.definition.enabled &&
    entry.status.enabled &&
    entry.status.state !== 'merged' &&
    entry.status.state !== 'closed' &&
    entry.status.state !== 'disabled'
  )
}

function getListApi(): Pick<HostedReviewSitterApi, 'list'> | null {
  const candidate: unknown = window.api?.hostedReviewSitter
  if (!candidate || typeof candidate !== 'object') {
    return null
  }
  const list = (candidate as Partial<HostedReviewSitterApi>).list
  return typeof list === 'function' ? { list } : null
}

let snapshot: ReadonlyMap<string, HostedReviewSitterStatusState> = new Map()
const subscribers = new Set<() => void>()
let pollHandle: number | null = null

function matchesSnapshot(next: ReadonlyMap<string, HostedReviewSitterStatusState>): boolean {
  if (next.size !== snapshot.size) {
    return false
  }
  for (const [worktreeId, state] of next) {
    if (snapshot.get(worktreeId) !== state) {
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
  let entries: HostedReviewSitterListEntry[]
  try {
    entries = await api.list()
  } catch {
    // a transient bridge failure is not evidence the sitter stopped; keep the last snapshot
    return
  }
  const next = new Map<string, HostedReviewSitterStatusState>()
  for (const entry of entries) {
    if (isActiveHostedReviewSitter(entry)) {
      next.set(entry.definition.worktreeId, entry.status.state)
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
  // window.api is installed by preload before React mounts, so an absent bridge stays absent —
  // polling it would never yield anything, and in tests it leaks a live interval.
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

/**
 * Status of the armed sitter owning `worktreeId`, or `null` when none is.
 *
 * Every caller shares one poll: the interval starts with the first subscriber and stops with the
 * last, so a sidebar of N worktree cards costs one `list()` per tick rather than N.
 */
export function useActiveHostedReviewSitterState(
  worktreeId: string
): HostedReviewSitterStatusState | null {
  return useSyncExternalStore(
    subscribe,
    () => snapshot.get(worktreeId) ?? null,
    () => null
  )
}
