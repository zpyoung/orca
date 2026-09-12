import type { LedgerRequest, LedgerResponse } from '../../shared/ledger'
import type { HandlerContext } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import { createOrchestrationCompatibilityEnvelope } from '../runtime/orchestration-compatibility-envelope'

export async function request(
  ctx: HandlerContext,
  request: LedgerRequest
): Promise<LedgerResponse> {
  const status = await ctx.client.call<{ capabilities?: string[] }>('status.get')
  if (!status.result.capabilities?.includes('ledger.v1')) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'Selected runtime does not support ledger.v1'
    )
  }
  const response = await ctx.client.call<LedgerResponse>(
    'ledger.request',
    { request },
    createOrchestrationCompatibilityEnvelope(process.env)
  )
  return response.result
}
