import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { ObjectiveDatabase } from './objective-database'
import { createObjectiveKind, type ObjectiveKind } from './kind'
import { ObjectiveStore } from './objective-store'

export type ObjectiveKernelRegistration = {
  registerKind(kind: ObjectiveKind): void
}

export type ObjectiveRegistration = {
  store: ObjectiveStore
  dispose(): void
}

export function registerObjectiveKind(
  kernel: ObjectiveKernelRegistration,
  runtime: OrcaRuntimeService,
  store: Store,
  storageAuthority: 'desktop' | 'runtime' = 'desktop'
): ObjectiveRegistration {
  const database = new ObjectiveDatabase(store)
  const objectiveStore = new ObjectiveStore(database)
  kernel.registerKind(createObjectiveKind({ runtime, store, objectiveStore, storageAuthority }))
  return {
    store: objectiveStore,
    dispose: () => database.close()
  }
}
