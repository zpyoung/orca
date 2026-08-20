// Shared LRU bound for the composer's per-scope caches (draft text, history,
// and image attachments), all keyed by stable pane identity. The
// caches exist so an in-progress message survives the composer unmounting on a
// TUI/GUI toggle, but a scope key for a permanently-removed pane is never
// revisited, so without a bound its unsent entry would linger for the renderer's
// whole session. delete-then-set keeps the actively-edited scope most-recent so
// eviction only sheds the oldest untouched scopes.
//
// A scope with a live subscriber (any per-scope cache) is pinned and skipped by
// eviction: mounted React state can mask a bounded cache silently dropping a
// still-open pane's payload, so eviction must only ever shed dead scopes.
export const NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX = 128

const pinnedScopeCounts = new Map<string, number>()

/** Pins `scopeKey` against eviction while at least one caller holds a pin. Returns the unpin function. */
export function pinScopeCacheKey(scopeKey: string): () => void {
  pinnedScopeCounts.set(scopeKey, (pinnedScopeCounts.get(scopeKey) ?? 0) + 1)
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    const count = pinnedScopeCounts.get(scopeKey) ?? 0
    if (count <= 1) {
      pinnedScopeCounts.delete(scopeKey)
    } else {
      pinnedScopeCounts.set(scopeKey, count - 1)
    }
  }
}

function isScopeCacheKeyPinned(scopeKey: string): boolean {
  return (pinnedScopeCounts.get(scopeKey) ?? 0) > 0
}

function oldestUnpinnedKey<T>(cache: Map<string, T>, excludeKey: string): string | undefined {
  for (const key of cache.keys()) {
    // never evict the entry this write just landed, even if it isn't itself pinned yet
    if (key !== excludeKey && !isScopeCacheKeyPinned(key)) {
      return key
    }
  }
  return undefined
}

export function setBoundedScopeCacheEntry<T>(
  cache: Map<string, T>,
  scopeKey: string,
  value: T
): void {
  cache.delete(scopeKey)
  cache.set(scopeKey, value)
  while (cache.size > NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX) {
    const oldest = oldestUnpinnedKey(cache, scopeKey)
    if (oldest === undefined) {
      // every entry is pinned (live) — grow past the cap rather than evict live state
      break
    }
    cache.delete(oldest)
  }
}

export function clearScopeCachePinsForTests(): void {
  pinnedScopeCounts.clear()
}
