import { describe, expect, it } from 'vitest'
import {
  canonicalLedgerSourceAnchor,
  ledgerSourceAnchor,
  ledgerSourceAnchorsCollide
} from './ledger-source-identity'

describe('ledger source identity', () => {
  it('uses JSON tuple anchors and ignores Project hosts', () => {
    const first = ledgerSourceAnchor(
      { kind: 'project', id: 'repo-a', host: 'host-a' },
      './BUGS.md',
      'BUG-3'
    )
    const second = ledgerSourceAnchor(
      { kind: 'project', id: 'repo-a', host: 'host-b' },
      'BUGS.md',
      'BUG-3'
    )
    expect(first).toBe(second)
    expect(JSON.parse(first)).toEqual(['project', 'repo-a', null, 'BUGS.md', 'BUG-3'])
  })

  it('includes normalized workspace host while preserving path and ID case', () => {
    const anchor = ledgerSourceAnchor(
      { kind: 'workspace', id: 'Workspace-A', host: ' SSH://HOST ' },
      'src\\BUGS.md',
      'Bug-3'
    )
    expect(JSON.parse(anchor)).toEqual([
      'workspace',
      'Workspace-A',
      'ssh://host',
      'src/BUGS.md',
      'Bug-3'
    ])
  })

  it('canonicalizes equivalent Project anchors without changing unrelated anchors', () => {
    const oldAnchor = ledgerSourceAnchor({ kind: 'project', id: 'old' }, 'BUGS.md', 'BUG-3')
    const newAnchor = ledgerSourceAnchor({ kind: 'project', id: 'new' }, 'BUGS.md', 'BUG-3')
    expect(canonicalLedgerSourceAnchor(oldAnchor, [['old', 'new']])).toBe(
      canonicalLedgerSourceAnchor(newAnchor, [['old', 'new']])
    )
    expect(ledgerSourceAnchorsCollide(oldAnchor, newAnchor, [['old', 'new']])).toBe(true)
    expect(
      ledgerSourceAnchorsCollide(
        oldAnchor,
        ledgerSourceAnchor({ kind: 'project', id: 'other' }, 'BUGS.md', 'BUG-3'),
        [['old', 'new']]
      )
    ).toBe(false)
  })
})
