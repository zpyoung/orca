import type { AttemptEntry } from '../../../shared/fork-heimdall/ledger-types'
import type { WatcherDetail } from '../../../shared/fork-heimdall/fleet-types'

export type HeimdallFleetAction = {
  watcherKey: string
  watcherName: string
  attempt: AttemptEntry
}

export function projectFleetActions(details: readonly WatcherDetail[]): HeimdallFleetAction[] {
  const latest = new Map<string, HeimdallFleetAction>()
  for (const detail of details) {
    for (const entry of detail.ledger.entries) {
      if (entry.kind !== 'attempt') {
        continue
      }
      const watcherKey = `${detail.watcher.target.connectionId ?? 'local'}:${detail.watcher.target.pairingRevision ?? 'local'}:${detail.watcher.target.watcherId}`
      const key = `${watcherKey}:${entry.attemptId}`
      const previous = latest.get(key)
      if (!previous || previous.attempt.atMs <= entry.atMs) {
        latest.set(key, {
          watcherKey,
          watcherName: detail.watcher.entry.name,
          attempt: entry
        })
      }
    }
  }
  return [...latest.values()].sort((left, right) => right.attempt.atMs - left.attempt.atMs)
}
