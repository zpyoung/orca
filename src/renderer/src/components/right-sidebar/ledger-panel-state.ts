import type { LedgerEntry } from '../../../../shared/ledger'

export type LedgerPanelState =
  | { kind: 'no-workspace' | 'loading' | 'empty' | 'entries' }
  | { kind: 'owner-ambiguous' | 'group-missing' | 'workspace-missing' | 'owner-missing' }
  | { kind: 'error'; message: string }

export function getLedgerPanelState({
  loading,
  error,
  entries,
  hasWorkspace
}: {
  loading: boolean
  error: { code?: string; message: string } | null
  entries: LedgerEntry[]
  hasWorkspace: boolean
}): LedgerPanelState {
  if (!hasWorkspace) {
    return { kind: 'no-workspace' }
  }
  if (error) {
    switch (error.code) {
      case 'owner-ambiguous':
      case 'group-missing':
      case 'workspace-missing':
      case 'owner-missing':
        return { kind: error.code }
      case undefined:
      default:
        return { kind: 'error', message: error.message }
    }
  }
  if (loading && !entries.length) {
    return { kind: 'loading' }
  }
  return { kind: entries.length ? 'entries' : 'empty' }
}
