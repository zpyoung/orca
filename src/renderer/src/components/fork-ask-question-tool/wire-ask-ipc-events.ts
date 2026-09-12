import type { AsksSlice } from '@/store/slices/fork-ask-question-tool/asks'
import { wireClaudeSuppressionVerdict } from './claude-suppression-verdict-bridge'

type AskStore = { getState: () => Pick<AsksSlice, 'hydrateAsks' | 'applyAskRegistryEvent'> }

/**
 * Starts the asks slice's hydration and forwards every `ask:set` IPC event to it. Injecting
 * `store` (rather than importing `useAppStore` directly) keeps this testable without the full
 * app store. Returns the preload disposer for the caller's own unmount cleanup (tech.md § C8).
 */
export function wireAskIpcEvents(store: AskStore): () => void {
  const asksApi: typeof window.api.asks | undefined = window.api.asks
  const state: Partial<ReturnType<AskStore['getState']>> = store.getState()
  // upstream's useIpcEvents tests drive this bridge with partial store and preload doubles
  if (!asksApi || typeof state.hydrateAsks !== 'function') {
    return () => {}
  }
  void state.hydrateAsks()
  const stopVerdict = wireClaudeSuppressionVerdict(asksApi)
  const stopAskEvents = asksApi.onSet((event) => {
    store.getState().applyAskRegistryEvent(event)
  })
  return () => {
    stopAskEvents()
    stopVerdict()
  }
}
