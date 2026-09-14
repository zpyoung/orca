import type { HeimdallKernelService } from '../../../../fork-heimdall/kernel-service'

const kernels = new WeakMap<object, HeimdallKernelService>()

export function bindHeimdallKernel(runtime: object, kernel: HeimdallKernelService): void {
  kernels.set(runtime, kernel)
}

export function requireHeimdallKernel(runtime: object): HeimdallKernelService {
  const kernel = kernels.get(runtime)
  if (!kernel) {
    throw new Error('Heimdall is unavailable on this runtime: owner-not-executable')
  }
  return kernel
}
