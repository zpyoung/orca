import type { KernelAction, WatcherKind } from '../../shared/fork-heimdall/kind-contract'
import type { WatcherKindId } from '../../shared/fork-heimdall/watcher-types'

export type RegisteredWatcherKind = WatcherKind<unknown, KernelAction, unknown>

/** In-tree kind registry. Registration is startup-only; replacing a kind would change replay semantics. */
export class WatcherKindRegistry {
  private readonly kinds = new Map<WatcherKindId, RegisteredWatcherKind>()

  register(kind: RegisteredWatcherKind): void {
    if (this.kinds.has(kind.id)) {
      throw new Error(`Duplicate Heimdall watcher kind: ${kind.id}`)
    }
    this.kinds.set(kind.id, kind)
  }

  get(id: WatcherKindId): RegisteredWatcherKind | null {
    return this.kinds.get(id) ?? null
  }

  list(): readonly RegisteredWatcherKind[] {
    return [...this.kinds.values()]
  }
}
