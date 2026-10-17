import type { LoopService } from '../../../../fork-loops/loop-service'
import { LoopStoreError } from '../../../../fork-loops/loop-database'
import type { OrcaRuntimeService } from '../../../orca-runtime'

const loopServices = new WeakMap<OrcaRuntimeService, LoopService>()

export function bindLoopService(runtime: OrcaRuntimeService, service: LoopService): void {
  loopServices.set(runtime, service)
}

export function requireLoopService(runtime: OrcaRuntimeService): LoopService {
  const service = loopServices.get(runtime)
  if (!service) {
    throw new LoopStoreError('loop_runtime_unavailable', 'Loops are unavailable on this runtime')
  }
  return service
}
