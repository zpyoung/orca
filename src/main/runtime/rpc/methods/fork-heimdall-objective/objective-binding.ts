import type { OrcaRuntimeService } from '../../../../runtime/orca-runtime'
import type { ObjectiveStore } from '../../../../fork-heimdall-objective/objective-store'

const stores = new WeakMap<OrcaRuntimeService, ObjectiveStore>()

export function bindHeimdallObjectiveStore(
  runtime: OrcaRuntimeService,
  store: ObjectiveStore
): void {
  stores.set(runtime, store)
}

export function requireHeimdallObjectiveStore(runtime: OrcaRuntimeService): ObjectiveStore {
  const store = stores.get(runtime)
  if (!store) {
    throw new Error('Heimdall objective store is unavailable on this runtime')
  }
  return store
}
