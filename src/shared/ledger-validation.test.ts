import { describe, expect, it } from 'vitest'
import { LedgerError, type LedgerRecord } from './ledger'
import { validateLedgerContent } from './ledger-content-validation'
import { validateLedgerRequest } from './ledger-request-validation'
import { validateLedgerStoreRecord } from './ledger-record-validation'

const record = (): LedgerRecord => ({
  version: 1,
  ledgerId: 'l1',
  tier: 'project',
  revision: 1,
  owner: null,
  formerOwner: null,
  runtime: { runtimeId: 'r1', profileId: 'p1' },
  entryCount: 1,
  nextSequence: 2,
  staleAfterDays: 90,
  sourceEquivalences: [],
  entries: [
    {
      id: 'bug-1',
      type: 'bug',
      sequence: 1,
      revision: 1,
      content: {
        title: 'x',
        file: { path: 'a.ts', line: 1, base: { kind: 'project', id: 'p1' } },
        description: 'd',
        severity: 'low'
      },
      state: 'open',
      reviewed: false,
      origin: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      latestContentActor: { kind: 'unknown', model: null, providerSessionId: null },
      history: [
        {
          revision: 1,
          at: '2026-01-01T00:00:00.000Z',
          actor: { kind: 'unknown', model: null, providerSessionId: null },
          before: null,
          after: { content: { title: 'x' }, state: 'open', reviewed: false },
          changedFields: []
        }
      ]
    }
  ],
  importAnchors: { old: { deleted: true, entryId: 'bug-99' } },
  metadataHistory: []
})

describe('ledger runtime validation', () => {
  it('requires nonempty text for every required field', () => {
    expect(() =>
      validateLedgerContent('bug', {
        title: 1,
        file: { path: 'a.ts', line: 1, base: { kind: 'project', id: 'p1' } },
        description: 'x',
        severity: 'low'
      })
    ).toThrow(LedgerError)
    expect(() =>
      validateLedgerContent('bug', {
        title: 'x',
        file: 'a.ts:1',
        description: ' ',
        severity: 'low'
      })
    ).toThrow(LedgerError)
    expect(() =>
      validateLedgerContent('bug', {
        title: 'x',
        file: { path: 'a.ts', line: 1, base: { kind: 'project', id: 'p1' } },
        description: 'x',
        severity: 'low'
      })
    ).not.toThrow()
  })
  it('rejects duplicate selections and allows list-like review without an id', () => {
    expect(() =>
      validateLedgerRequest({
        operation: 'approve',
        selections: [
          { id: 'bug-1', revision: 1 },
          { id: 'bug-1', revision: 2 }
        ]
      })
    ).toThrow(LedgerError)
    expect(() => validateLedgerRequest({ operation: 'review' })).not.toThrow()
    expect(() => validateLedgerRequest({ operation: 'show' })).toThrow(LedgerError)
    expect(() =>
      validateLedgerRequest({
        operation: 'edit',
        id: 'bug-1',
        content: {},
        ifRevision: 1,
        target: { workspaceId: 'w', ledgerId: 'l' }
      })
    ).toThrow(LedgerError)
  })
  it('accepts body-free hard-deleted anchors and rejects unknown semantic history', () => {
    expect(() => validateLedgerStoreRecord(record())).not.toThrow()
    const corrupted = record()
    ;(corrupted.entries[0].history[0].after as Record<string, unknown>).state = 'unknown'
    expect(() => validateLedgerStoreRecord(corrupted)).toThrow(LedgerError)
  })
})
