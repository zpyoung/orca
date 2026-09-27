import type { StateCreator } from 'zustand'
import type {
  LedgerEntry,
  LedgerRequest,
  LedgerResponse,
  LedgerSummary
} from '../../../../shared/ledger'
import type { AppState } from '../types'
import { requestLedger } from '@/runtime/runtime-ledger-client'

export type LedgerSlice = {
  ledgerSummary: LedgerSummary | null
  ledgerEntries: LedgerEntry[]
  ledgerLoading: boolean
  ledgerError: string | null
  ledgerRequest: (request: LedgerRequest, environmentId?: string) => Promise<LedgerResponse>
  loadLedger: (request: LedgerRequest, environmentId?: string) => Promise<void>
  clearLedgerError: () => void
  ledgerSelectionKey: string | null
  ledgerGeneration: number
}

export const createLedgerSlice: StateCreator<AppState, [], [], LedgerSlice> = (set, get) => ({
  ledgerSummary: null,
  ledgerEntries: [],
  ledgerLoading: false,
  ledgerError: null,
  ledgerSelectionKey: null,
  ledgerGeneration: 0,
  ledgerRequest: (request, environmentId) => requestLedger(request, environmentId),
  loadLedger: async (request, environmentId) => {
    const selectionKey = JSON.stringify([environmentId ?? null, request.target ?? null])
    const generation = (get().ledgerGeneration ?? 0) + 1
    const selectionChanged = get().ledgerSelectionKey !== selectionKey
    set({
      ledgerGeneration: generation,
      ledgerSelectionKey: selectionKey,
      ledgerLoading: true,
      ledgerError: null,
      ...(selectionChanged ? { ledgerSummary: null, ledgerEntries: [] } : {})
    })
    try {
      const response = await requestLedger(request, environmentId)
      if (get().ledgerGeneration !== generation || get().ledgerSelectionKey !== selectionKey) {
        return
      }
      set({
        ledgerSummary: response.ledger,
        ledgerEntries: response.entries ?? [],
        ledgerLoading: false
      })
    } catch (error) {
      if (get().ledgerGeneration !== generation || get().ledgerSelectionKey !== selectionKey) {
        return
      }
      set({
        ledgerLoading: false,
        ledgerError: error instanceof Error ? error.message : 'Ledger unavailable'
      })
    }
  },
  clearLedgerError: () => set({ ledgerError: null })
})
