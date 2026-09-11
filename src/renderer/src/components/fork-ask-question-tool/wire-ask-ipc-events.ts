import type { AsksSlice } from '@/store/slices/fork-ask-question-tool/asks'
import { wireClaudeSuppressionVerdict } from './claude-suppression-verdict-bridge'

type AskStore = { getState: () => Pick<AsksSlice, 'hydrateAsks' | 'applyAskRegistryEvent'> }

/**
 * Starts the asks slice's hydration and forwards every `ask:set` IPC event to it. Injecting
 * `store` (rather than importing `useAppStore` directly) keeps this testable without the full
 * app store. Returns the preload disposer for the caller's own unmount cleanup (tech.md § C8).
 */
export function wireAskIpcEvents(store: AskStore): () => void {
  void store.getState().hydrateAsks()
  const stopVerdict = wireClaudeSuppressionVerdict(window.api.asks)
  const stopAskEvents = window.api.asks.onSet((event) => {
    store.getState().applyAskRegistryEvent(event)
  })
  return () => {
    stopAskEvents()
    stopVerdict()
  }
}
