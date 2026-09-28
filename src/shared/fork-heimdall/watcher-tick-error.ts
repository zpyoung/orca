import type { WatcherStatus } from './watcher-types'

/**
 * The phase a runner publishes when a tick failed locally while the execution host stayed in
 * contact. It rides on the existing `held` state so hosts never publish a state arm older clients
 * would reject; `unreachable` stays reserved for lost contact with the execution host.
 */
export const WATCHER_TICK_ERROR_PHASE = 'tick-error'

/** True when the owner is reachable but its ticks keep failing and backing off. */
export function isWatcherTickErrorStatus(status: Pick<WatcherStatus, 'state' | 'phase'>): boolean {
  return status.state === 'held' && status.phase === WATCHER_TICK_ERROR_PHASE
}
