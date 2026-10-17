import type { LoopsSlice } from './loops-slice'

type LoopsStore = {
  getState: () => Pick<LoopsSlice, 'hydrateLoops' | 'applyLoopSnapshot'>
}

/** Seeds once from `list`, then applies every pushed snapshot. */
export function wireLoopsIpcEvents(store: LoopsStore): () => void {
  const api = window.api?.loops
  const state = store.getState()
  if (
    !api ||
    typeof api.list !== 'function' ||
    typeof api.onChanged !== 'function' ||
    typeof state.hydrateLoops !== 'function'
  ) {
    return () => {}
  }
  const unsubscribe = api.onChanged((snapshot) => {
    store.getState().applyLoopSnapshot(snapshot)
  })
  void state.hydrateLoops()
  return unsubscribe
}
