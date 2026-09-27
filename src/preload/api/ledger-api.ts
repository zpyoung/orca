import type { LedgerRequest, LedgerResponse } from '../../shared/ledger'

export type LedgerApi = {
  request: (request: LedgerRequest, environmentId?: string) => Promise<LedgerResponse>
}
