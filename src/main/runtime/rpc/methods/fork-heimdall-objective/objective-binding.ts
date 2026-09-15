import type { ObjectiveStore } from '../../../../fork-heimdall-objective/objective-store'

const stores = new WeakMap<object, ObjectiveStore>()

export function bindHeimdallObjectiveStore(runtime: object, store: ObjectiveStore): void {
  stores.set(runtime, store)
}

export function requireHeimdallObjectiveStore(runtime: object): ObjectiveStore {
  const store = stores.get(runtime)
  if (!store) {
    throw new Error('Heimdall objective store is unavailable on this runtime')
  }
  return store
}
