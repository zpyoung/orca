import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { bindHeimdallKernel } from '../runtime/rpc/methods/fork-heimdall/kernel-binding'
import { registerHostedReviewKind } from '../fork-hosted-review-sitter/kind'
import { registerHostedReviewAgentIpcHandlers } from '../fork-hosted-review-sitter/registration'
import { HeimdallKernelServiceImpl, type HeimdallKernelService } from './kernel-service'

export function startHeimdall(
  runtime: OrcaRuntimeService,
  store: Store,
  isServeMode: boolean
): HeimdallKernelService | null {
  if (isServeMode) {
    return null
  }
  const kernel = new HeimdallKernelServiceImpl({ runtime, store })
  registerHostedReviewKind(kernel, runtime, store)
  registerHostedReviewAgentIpcHandlers(runtime, store)
  bindHeimdallKernel(runtime, kernel)
  return kernel
}
