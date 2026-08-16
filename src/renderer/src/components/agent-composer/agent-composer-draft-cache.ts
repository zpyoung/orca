// Module-level cache for the composer's in-progress draft text, keyed by the
// same stable pane scope as image attachments. The composer unmounts when the
// pane toggles back to the hosted terminal, so without this the typed-but-unsent
// draft would be lost on every TUI/GUI round-trip. Mirrors the attachment cache
// so both halves of an unsent message survive toggles and reconnects. Also
// mirrors agent-composer-history-cache's subscribe/notify shape, since the dock
// and native-chat view can both hold a live mount against the same pane.

import { setBoundedScopeCacheEntry } from './agent-composer-scope-cache'

const draftCache = new Map<string, string>()

type DraftCacheListener = (draft: string) => void
const draftCacheListeners = new Map<string, Set<DraftCacheListener>>()

export function readAgentComposerDraftCache(scopeKey: string): string {
  return draftCache.get(scopeKey) ?? ''
}

export function writeAgentComposerDraftCache(scopeKey: string, draft: string): void {
  // An empty draft carries no state worth retaining; drop the entry so a stale
  // scope key never resurrects cleared text.
  if (draft === '') {
    draftCache.delete(scopeKey)
  } else {
    // LRU-bounded so unsent drafts for permanently-removed panes can't accumulate.
    setBoundedScopeCacheEntry(draftCache, scopeKey, draft)
  }
  notifyDraftCacheListeners(scopeKey, draft)
}

/**
 * Subscribes to writes for `scopeKey`. Fires once immediately with the
 * current value, then on every subsequent write, so a mount that subscribes
 * after another mount already wrote cannot miss that entry. Returns an
 * unsubscribe function.
 */
export function subscribeAgentComposerDraftCache(
  scopeKey: string,
  listener: DraftCacheListener
): () => void {
  const listeners = draftCacheListeners.get(scopeKey) ?? new Set<DraftCacheListener>()
  draftCacheListeners.set(scopeKey, listeners)
  listeners.add(listener)
  try {
    listener(readAgentComposerDraftCache(scopeKey))
  } catch {
    // a subscriber's exception must never stop this subscribe call from completing
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      draftCacheListeners.delete(scopeKey)
    }
  }
}

function notifyDraftCacheListeners(scopeKey: string, draft: string): void {
  const listeners = draftCacheListeners.get(scopeKey)
  if (!listeners) {
    return
  }
  // snapshot: a listener unsubscribing another mid-dispatch must not skip it
  for (const listener of Array.from(listeners)) {
    try {
      listener(draft)
    } catch {
      // a subscriber's exception must never block the other listeners
    }
  }
}

export function clearAgentComposerDraftCacheForTests(): void {
  draftCache.clear()
  draftCacheListeners.clear()
}
