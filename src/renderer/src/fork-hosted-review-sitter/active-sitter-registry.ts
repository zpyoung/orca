import type {
  WatcherListEntry,
  WatcherStatusState
} from '../../../shared/fork-heimdall/watcher-types'
import type { WatcherListEntryReader } from '../../../shared/fork-heimdall/remote-reader-schemas'
import {
  isActiveHeimdallWatcher,
  useActiveHeimdallWatcherState
} from '../fork-heimdall/active-watcher-registry'

/** A hosted-review watcher still owns its review and workspace. */
export function isActiveHostedReviewSitter(
  entry: WatcherListEntryReader
): entry is WatcherListEntry {
  return entry.enrollment.kind === 'hosted-review' && isActiveHeimdallWatcher(entry)
}

/** Hosted-review projection of the shared pushed Heimdall fleet cache. */
export function useActiveHostedReviewSitterState(worktreeId: string): WatcherStatusState | null {
  const watcher = useActiveHeimdallWatcherState(worktreeId)
  return watcher?.kind === 'hosted-review' ? watcher.state : null
}
