import type { WatcherKindId } from '../../shared/fork-heimdall/watcher-types'
import type { EnrollmentStore } from './enrollment-store'
import type { WatcherKindRegistry } from './registry'

/** Replays committed watcher deletion cleanup once its registered kind is available. */
export async function drainPendingKindPurges(
  enrollments: EnrollmentStore,
  registry: WatcherKindRegistry,
  onlyKind?: WatcherKindId
): Promise<void> {
  for (const pending of enrollments.pendingKindPurges()) {
    if (onlyKind && pending.kind !== onlyKind) {
      continue
    }
    const kind = registry.get(pending.kind)
    if (!kind) {
      continue
    }
    try {
      const purge = kind.purge?.(pending.watcherId)
      if (purge) {
        await purge
      }
      enrollments.completeKindPurge(pending.watcherId)
    } catch (error) {
      console.warn(
        `[heimdall] pending ${pending.kind} purge failed for ${pending.watcherId}:`,
        error
      )
    }
  }
}
