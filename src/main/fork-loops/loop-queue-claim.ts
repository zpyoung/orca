import type { QueueItem } from './loop-database'
import type { LoopStore } from './loop-store'

/**
 * Marks the queue item this iteration will work on as in-flight and returns it. A retry or re-run
 * reuses the item already in flight; naming a finished item restarts the whole queue.
 */
export function claimQueueItem(
  store: LoopStore,
  loopId: string,
  source: 'repeat' | { queueItemId: string },
  reuseInFlight: boolean
): QueueItem | null {
  const items = store.listQueue(loopId)
  const inFlight = items.find((item) => item.state === 'in-flight')
  if (reuseInFlight && inFlight) {
    return inFlight
  }
  if (source === 'repeat') {
    return null
  }
  const chosen = items.find((item) => item.id === source.queueItemId) ?? null
  if (chosen?.state === 'done') {
    for (const item of items) {
      store.setQueueItemState(loopId, item.id, 'pending')
    }
  }
  if (chosen) {
    store.setQueueItemState(loopId, chosen.id, 'in-flight')
  }
  return chosen
}
