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

type EnumOwner = 'bug' | 'deferred' | 'test-gap' | 'decision'

function enumRecord(type: EnumOwner): LedgerRecord {
  const value = record()
  const entry = value.entries[0]
  entry.type = type
  entry.id = `${type}-1`
  entry.content =
    type === 'bug'
      ? {
          title: 'bug',
          file: { path: 'bug.ts', base: { kind: 'project', id: 'p1' } },
          description: 'description',
          severity: 'low'
        }
      : type === 'deferred'
        ? { title: 'deferred', why_deferred: 'later', priority: 'low' }
        : type === 'test-gap'
          ? {
              title: 'test gap',
              file_under_test: { path: 'gap.ts', base: { kind: 'project', id: 'p1' } },
              reason_skipped: 'later'
            }
          : {
              title: 'decision',
              context: 'context',
              decision: 'decision',
              consequences: 'consequences',
              status: 'proposed'
            }
  return value
}

function snapshot(content: Record<string, unknown>) {
  return { content: structuredClone(content), state: 'open' as const, reviewed: false }
}

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

  it.each([
    { type: 'test-gap' as const, field: 'priority', value: 'p3' },
    { type: 'deferred' as const, field: 'status', value: 'resolved' }
  ])(
    'accepts off-type $field values in before and after $type history',
    ({ type, field, value }) => {
      const stored = enumRecord(type)
      const content = { ...stored.entries[0].content, [field]: value }
      stored.entries[0].content = content
      const history = stored.entries[0].history[0]
      history.before = snapshot(content)
      history.after = snapshot(content)
      const validated = validateLedgerStoreRecord(stored)
      expect(validated.entries[0].history[0].before?.content[field]).toBe(value)
      expect(validated.entries[0].history[0].after?.content[field]).toBe(value)
    }
  )

  it.each([
    { type: 'bug' as const, field: 'severity', value: 'urgent' },
    { type: 'deferred' as const, field: 'priority', value: 'p3' },
    { type: 'decision' as const, field: 'status', value: 'resolved' }
  ])(
    'rejects invalid owning-type $field values in before and after $type history',
    ({ type, field, value }) => {
      for (const side of ['before', 'after'] as const) {
        const corrupted = enumRecord(type)
        const validSnapshot = snapshot(corrupted.entries[0].content)
        const history = corrupted.entries[0].history[0]
        history.before = structuredClone(validSnapshot)
        history.after = structuredClone(validSnapshot)
        history[side] = snapshot({ ...corrupted.entries[0].content, [field]: value })
        expect(() => validateLedgerStoreRecord(corrupted)).toThrow(LedgerError)
      }
    }
  )
})
