import { describe, expect, it } from 'vitest'
import type { LedgerEntry } from '../../../../shared/ledger'
import { getLedgerPanelState } from './ledger-panel-state'

const base = { loading: false, error: null, entries: [], hasWorkspace: true }
describe('ledger panel states', () => {
  it('prioritizes missing selection over old data and errors', () => {
    expect(
      getLedgerPanelState({
        ...base,
        hasWorkspace: false,
        loading: true,
        error: { code: 'workspace-missing', message: 'old' }
      })
    ).toEqual({ kind: 'no-workspace' })
  })
  it('loads only when there are no cached entries', () => {
    expect(getLedgerPanelState({ ...base, loading: true })).toEqual({ kind: 'loading' })
    expect(getLedgerPanelState({ ...base, loading: true, entries: [{} as LedgerEntry] })).toEqual({
      kind: 'entries'
    })
  })
  it('treats an uncreated ledger as empty', () => {
    expect(getLedgerPanelState(base)).toEqual({ kind: 'empty' })
  })
  it.each(['owner-ambiguous', 'group-missing', 'workspace-missing', 'owner-missing'])(
    'distinguishes %s',
    (code) => {
      expect(getLedgerPanelState({ ...base, error: { code, message: 'server' } })).toEqual({
        kind: code
      })
    }
  )
  it.each(['disconnected', undefined])('preserves generic error text for %s', (code) => {
    expect(getLedgerPanelState({ ...base, error: { code, message: 'Try again' } })).toEqual({
      kind: 'error',
      message: 'Try again'
    })
  })
})
