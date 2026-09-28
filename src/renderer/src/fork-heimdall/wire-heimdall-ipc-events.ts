import type { HeimdallFleetSlice } from '@/store/slices/fork-heimdall/fleet'

type FleetStore = {
  getState: () => Pick<HeimdallFleetSlice, 'hydrateHeimdallFleet' | 'applyHeimdallFleetSnapshot'>
}

/** Seeds once, then accepts only owner-produced snapshots from the preload subscription. */
export function wireHeimdallIpcEvents(store: FleetStore): () => void {
  const api = window.api?.heimdall
  const state = store.getState()
  if (
    !api ||
    typeof api.fleet !== 'function' ||
    typeof api.onFleetChanged !== 'function' ||
    typeof state.hydrateHeimdallFleet !== 'function'
  ) {
    return () => {}
  }
  const unsubscribe = api.onFleetChanged((snapshot) => {
    store.getState().applyHeimdallFleetSnapshot(snapshot)
  })
  void state.hydrateHeimdallFleet()
  return unsubscribe
}
