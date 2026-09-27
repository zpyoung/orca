import type { LedgerRequest, LedgerResponse } from '../../../shared/ledger'

/** Routes ledger operations to the owning runtime; paired runtimes never fall back locally. */
export async function requestLedger(
  request: LedgerRequest,
  environmentId?: string
): Promise<LedgerResponse> {
  return window.api.ledger.request(request, environmentId)
}
