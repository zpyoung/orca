import type { LedgerTarget } from '../../../../../shared/ledger'
import type { TopLevelView } from '../../../../../shared/ui-chrome-types'

export type LedgerPageData = { target?: LedgerTarget; environmentId?: string; title?: string }

export type UISliceLedgerPage = {
  previousViewBeforeLedger: Exclude<TopLevelView, 'ledger'>
  ledgerPageData: LedgerPageData
  openLedgerPage: (data?: LedgerPageData) => void
  closeLedgerPage: () => void
}
