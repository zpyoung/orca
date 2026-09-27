import { describe, expect, it } from 'vitest'
import type { LedgerEntry, LedgerOrigin } from '../../shared/ledger'
import { ledgerEntryMatches } from './ledger-store-query'

const now = new Date('2026-01-31T00:00:00.000Z')

function entry(origin: LedgerOrigin): LedgerEntry {
  return {
    id: 'bug-1',
    type: 'bug',
    sequence: 1,
    revision: 1,
    content: { title: 'Broken' },
    state: 'open',
    reviewed: false,
    origin,
    createdAt: '2026-01-30T00:00:00.000Z',
    updatedAt: '2026-01-30T00:00:00.000Z',
    history: [],
    latestContentActor: { kind: 'human', model: null, providerSessionId: null }
  }
}

describe('ledgerEntryMatches', () => {
  it.each([
    ['folder:f1', 'f1'],
    ['f1', 'folder:f1'],
    ['folder:f1', 'folder:f1'],
    ['repo::/path', 'repo::/path']
  ])('matches filter %s against origin %s', (filtered, origin) => {
    expect(ledgerEntryMatches(entry({ workspaceId: origin }), { workspaceId: filtered }, now)).toBe(
      true
    )
  })
  it.each([
    ['folder:f1', 'f2'],
    ['repo::/path', 'repo::/other'],
    ['repo::/path', undefined]
  ])('rejects filter %s against origin %s', (filtered, origin) => {
    expect(ledgerEntryMatches(entry({ workspaceId: origin }), { workspaceId: filtered }, now)).toBe(
      false
    )
  })
  it('leaves the other filters independent of workspace scope', () => {
    const scoped = entry({ workspaceId: 'folder:f1', branch: 'main' })
    expect(ledgerEntryMatches(scoped, { workspaceId: 'f1', branch: 'main' }, now)).toBe(true)
    expect(ledgerEntryMatches(scoped, { workspaceId: 'f1', branch: 'other' }, now)).toBe(false)
    expect(ledgerEntryMatches(scoped, { workspaceId: 'f1', type: 'proposal' }, now)).toBe(false)
  })
})
