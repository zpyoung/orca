import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { Store } from '../persistence'
import type { PipelineStore } from './pipeline-store'

export type HeimdallPipelineBinding = {
  store: Store
  pipelineStore: PipelineStore
}

const bindings = new WeakMap<OrcaRuntimeService, HeimdallPipelineBinding>()

/** Binds profile and pipeline persistence to the runtime that owns their database. */
export function bindHeimdallPipeline(
  runtime: OrcaRuntimeService,
  dependencies: HeimdallPipelineBinding
): void {
  bindings.set(runtime, dependencies)
}

/** Returns the runtime's pipeline services or rejects an unavailable binding. */
export function requireHeimdallPipeline(runtime: OrcaRuntimeService): HeimdallPipelineBinding {
  const binding = bindings.get(runtime)
  if (!binding) {
    throw new Error('Heimdall pipeline services are unavailable on this runtime')
  }
  return binding
}
