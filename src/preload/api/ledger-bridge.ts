import { ipcRenderer } from 'electron'
import type { LedgerResponse } from '../../shared/ledger'
import type { LedgerApi } from './ledger-api'

type LedgerIpcResult =
  | { ok: true; result: LedgerResponse }
  | { ok: false; error: { code: string; message: string; details?: unknown } }

export const ledgerApi: LedgerApi = {
  request: async (request, environmentId) => {
    const response = (await ipcRenderer.invoke(
      'ledger:request',
      request,
      environmentId
    )) as LedgerIpcResult
    if (!response?.ok) {
      const error = new Error(response?.error?.message ?? 'Ledger request failed') as Error & {
        code?: string
        details?: unknown
      }
      error.code = response?.error?.code
      error.details = response?.error?.details
      throw error
    }
    return response.result
  }
}
