import type { LedgerEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { HeimdallLedgerStore } from './ledger-store'

export function fakeLedger(initial: LedgerEntry[] = []): {
  store: HeimdallLedgerStore
  entries: LedgerEntry[]
} {
  const entries = [...initial]
  const store = {
    read: (watcherId: string): WatcherLedger => ({
      watcherId,
      entries: entries.filter((entry) => entry.watcherId === watcherId)
    }),
    append: (entry: LedgerEntry): number => {
      entries.push(entry)
      return entries.length
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: HeimdallLedgerStore is a class with private fields, so a structural test double can never satisfy it without this cast; only read/append are exercised by the code under test.
  return { store: store as unknown as HeimdallLedgerStore, entries }
}
