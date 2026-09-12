import { describe, expect, it } from 'vitest'
import type { LedgerActor, LedgerMutationContext, LedgerRecord } from '../../shared/ledger'
import { applyLedgerBulk, createLedgerEntry, mutateLedgerEntry } from './ledger-entry-mutations'

const actor: LedgerActor = { kind: 'unknown', model: null, providerSessionId: null }
const context = (channel: 'cli' | 'ui' = 'cli'): LedgerMutationContext => ({ channel, actor })
const record = (): LedgerRecord => ({
  ledgerId: 'ledger-1',
  tier: 'project',
  revision: 0,
  owner: { tier: 'project', id: 'project-1' },
  formerOwner: null,
  runtime: { runtimeId: 'runtime-1', profileId: 'profile-1' },
  entryCount: 0,
  nextSequence: 1,
  staleAfterDays: 90,
  sourceEquivalences: [],
  entries: [],
  importAnchors: {},
  metadataHistory: []
})
const bug = (title: string) => ({
  title,
  file: { path: 'src/a.ts', base: { kind: 'project' as const, id: 'project-1' } },
  description: 'desc',
  severity: 'low'
})

describe('ledger entry mutations', () => {
  it('allocates one monotonic sequence across entry types and records a full initial snapshot', () => {
    const ledger = record()
    const first = createLedgerEntry(
      ledger,
      'bug',
      bug('one'),
      context(),
      '2026-09-09T00:00:00.000Z'
    )
    const second = createLedgerEntry(
      ledger,
      'proposal',
      { title: 'two', context: 'ctx', recommendation: 'do it' },
      context(),
      '2026-09-09T00:00:01.000Z'
    )
    expect([first.id, second.id]).toEqual(['bug-1', 'proposal-2'])
    expect(first.history[0].after).toMatchObject({
      content: bug('one'),
      state: 'open',
      reviewed: false
    })
  })

  it('rejects a stale two-editor mutation without touching the entry', () => {
    const ledger = record()
    const entry = createLedgerEntry(ledger, 'bug', bug('one'), context(), 'now')
    mutateLedgerEntry(
      ledger,
      { operation: 'edit', id: entry.id, ifRevision: 1, content: { title: 'two' } },
      context(),
      'later'
    )
    expect(() =>
      mutateLedgerEntry(
        ledger,
        { operation: 'edit', id: entry.id, ifRevision: 1, content: { title: 'stale' } },
        context(),
        'never'
      )
    ).toThrowError(/stale/)
    expect(entry.content.title).toBe('two')
  })

  it('distinguishes explicit review from the latest content writer and preserves review on no-op edit', () => {
    const ledger = record()
    const entry = createLedgerEntry(ledger, 'bug', bug('one'), context(), 'now')
    mutateLedgerEntry(
      ledger,
      { operation: 'edit', id: entry.id, ifRevision: 1, content: { title: 'two' } },
      context('ui'),
      'edit'
    )
    const writer = entry.latestContentActor
    mutateLedgerEntry(
      ledger,
      { operation: 'review', id: entry.id, ifRevision: 2 },
      context('ui'),
      'review'
    )
    expect(entry.reviewed).toBe(true)
    expect(entry.latestContentActor).toEqual(writer)
    expect(
      mutateLedgerEntry(
        ledger,
        { operation: 'edit', id: entry.id, ifRevision: entry.revision, content: { title: 'two' } },
        context('ui'),
        'noop'
      ).changed
    ).toBe(false)
    expect(entry.reviewed).toBe(true)
  })

  it('reverts editable fields and lifecycle while retaining unknown current fields', () => {
    const ledger = record()
    const entry = createLedgerEntry(ledger, 'bug', bug('one'), context(), 'now')
    entry.content.unknown = 'retain'
    mutateLedgerEntry(
      ledger,
      { operation: 'state', id: entry.id, ifRevision: 1, state: 'resolved' },
      context(),
      'state'
    )
    mutateLedgerEntry(
      ledger,
      {
        operation: 'edit',
        id: entry.id,
        ifRevision: 2,
        content: { title: 'two', description: 'changed' }
      },
      context(),
      'edit'
    )
    mutateLedgerEntry(
      ledger,
      { operation: 'revert', id: entry.id, ifRevision: 3, toRevision: 1 },
      context('ui'),
      'revert'
    )
    expect(entry.content).toMatchObject({ title: 'one', description: 'desc', unknown: 'retain' })
    expect(entry.state).toBe('open')
    expect(entry.reviewed).toBe(true)
  })

  it('preflights stale bulk selections and advances the ledger revision once', () => {
    const ledger = record()
    const one = createLedgerEntry(ledger, 'bug', bug('one'), context(), 'one')
    const two = createLedgerEntry(ledger, 'bug', bug('two'), context(), 'two')
    const before = ledger.revision
    expect(() =>
      applyLedgerBulk(
        ledger,
        {
          operation: 'bulk-state',
          state: 'resolved',
          confirmed: true,
          selections: [
            { id: one.id, revision: one.revision },
            { id: two.id, revision: one.revision - 1 }
          ]
        },
        context('ui'),
        'bulk'
      )
    ).toThrowError(/stale/)
    expect([one.state, two.state]).toEqual(['open', 'open'])
    expect(ledger.revision).toBe(before)
    const result = applyLedgerBulk(
      ledger,
      {
        operation: 'bulk-state',
        state: 'resolved',
        confirmed: true,
        selections: [
          { id: one.id, revision: one.revision },
          { id: two.id, revision: two.revision }
        ]
      },
      context('ui'),
      'bulk'
    )
    expect(result.changed).toBe(true)
    expect(ledger.revision).toBe(before + 1)
  })
})
