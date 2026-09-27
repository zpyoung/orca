import type { TopLevelView } from '../../../../../shared/ui-chrome-types'
import type { UISliceSet } from './ui-slice-contract'
import type { UISliceLedgerPage } from './ui-slice-contract-ledger-page'

export function createUiLedgerPageActions(set: UISliceSet): UISliceLedgerPage {
  return {
    previousViewBeforeLedger: 'terminal',
    ledgerPageData: {},
    openLedgerPage: (data = {}) =>
      set((state) => ({
        activeView: 'ledger',
        previousViewBeforeLedger:
          state.activeView === 'ledger'
            ? state.previousViewBeforeLedger
            : (state.activeView as Exclude<TopLevelView, 'ledger'>),
        ledgerPageData: data
      })),
    closeLedgerPage: () => set((state) => ({ activeView: state.previousViewBeforeLedger }))
  }
}
