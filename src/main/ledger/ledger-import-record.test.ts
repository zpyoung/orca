import { describe, expect, it } from 'vitest'
import { applyLedgerImportRecord } from './ledger-import-record'
import type { LedgerActor, LedgerImportRecord, LedgerRecord } from '../../shared/ledger'

const actor: LedgerActor = { kind: 'agent', model: null, providerSessionId: null, tool: 'codex' }
const context = { channel: 'cli' as const, actor }

function record(): LedgerRecord {
  return {
    ledgerId: 'ledger-1',
    tier: 'project',
    revision: 0,
    owner: { tier: 'project', id: 'project-a' },
    formerOwner: null,
    runtime: { runtimeId: 'local', profileId: 'default' },
    entryCount: 0,
    nextSequence: 1,
    staleAfterDays: 90,
    sourceEquivalences: [],
    entries: [],
    importAnchors: {},
    metadataHistory: []
  }
}

function source(
  title: string,
  anchor = '["project","project-a",null,"BUGS.md","BUG-1"]'
): LedgerImportRecord {
  return {
    anchor,
    type: 'bug',
    sourcePath: 'BUGS.md',
    sourceBase: { kind: 'project', id: 'project-a' },
    legacyId: 'BUG-1',
    content: {
      title,
      file: { path: 'src/a.ts', base: { kind: 'project', id: 'project-a' } },
      description: 'desc',
      severity: 'medium'
    }
  }
}

describe('applyLedgerImportRecord', () => {
  it('creates once, then preserves an unchanged source and human ledger edit', () => {
    const ledger = record()
    expect(
      applyLedgerImportRecord(ledger, source('first'), context, '2026-09-09T00:00:00.000Z').status
    ).toBe('created')
    const entry = ledger.entries[0]
    entry.content.description = 'human edit'
    expect(
      applyLedgerImportRecord(ledger, source('first'), context, '2026-09-09T00:01:00.000Z')
    ).toMatchObject({ status: 'already-present', changed: false, entryId: entry.id })
    expect(entry.content.description).toBe('human edit')
  })

  it('updates managed fields when only the source changed and removes deleted managed fields', () => {
    const ledger = record()
    const initial = source('first')
    initial.content.legacy_note = 'remove me'
    applyLedgerImportRecord(ledger, initial, context, '2026-09-09T00:00:00.000Z')
    const next = source('second')
    next.content = {
      title: 'second',
      file: { path: 'src/a.ts', base: { kind: 'project', id: 'project-a' } },
      description: 'desc',
      severity: 'high'
    }
    const result = applyLedgerImportRecord(ledger, next, context, '2026-09-09T00:01:00.000Z')
    expect(result).toMatchObject({ status: 'updated', changed: true })
    expect(ledger.entries[0].content).toMatchObject(next.content)
    expect(ledger.entries[0].content.legacy_note).toBeUndefined()
    expect(ledger.entries[0].reviewed).toBe(false)
    expect(ledger.entries[0].latestContentActor.kind).toBe('import')
  })

  it('treats current content equal to incoming source as bookkeeping-only', () => {
    const ledger = record()
    applyLedgerImportRecord(ledger, source('first'), context, '2026-09-09T00:00:00.000Z')
    const entry = ledger.entries[0]
    entry.content.title = 'second'
    const revision = entry.revision
    const ledgerRevision = ledger.revision
    const next = source('second')
    const result = applyLedgerImportRecord(ledger, next, context, '2026-09-09T00:01:00.000Z')
    expect(result).toMatchObject({ status: 'already-present', changed: true })
    expect(entry.revision).toBe(revision)
    expect(ledger.revision).toBe(ledgerRevision + 1)
  })

  it('skips a three-way conflict without changing the ledger', () => {
    const ledger = record()
    applyLedgerImportRecord(ledger, source('first'), context, '2026-09-09T00:00:00.000Z')
    ledger.entries[0].content.title = 'human'
    const revision = ledger.entries[0].revision
    const next = source('source')
    const result = applyLedgerImportRecord(ledger, next, context, '2026-09-09T00:01:00.000Z')
    expect(result).toMatchObject({ status: 'skipped', reason: 'conflict', changed: false })
    expect(ledger.entries[0].revision).toBe(revision)
    expect(ledger.entries[0].content.title).toBe('human')
  })

  it('reuses equivalent Project anchors and rejects canonical collisions', () => {
    const ledger = record()
    ledger.sourceEquivalences = [['project-a', 'project-old']]
    const first = source('first', '["project","project-old",null,"BUGS.md","BUG-1"]')
    applyLedgerImportRecord(ledger, first, context, '2026-09-09T00:00:00.000Z')
    const result = applyLedgerImportRecord(
      ledger,
      source('first'),
      context,
      '2026-09-09T00:01:00.000Z'
    )
    expect(result.entryId).toBe(ledger.entries[0].id)
    ledger.importAnchors['["project","project-a",null,"BUGS.md","BUG-1"]'] = {
      baseline: { title: 'other' },
      entryId: 'bug-99'
    }
    expect(
      applyLedgerImportRecord(ledger, source('latest'), context, '2026-09-09T00:02:00.000Z').reason
    ).toBe('canonical-anchor-collision')
  })

  it('never resurrects a tombstoned anchor and keeps the initiator separate', () => {
    const ledger = record()
    ledger.importAnchors[source('gone').anchor] = { deleted: true }
    expect(
      applyLedgerImportRecord(ledger, source('gone'), context, '2026-09-09T00:00:00.000Z')
    ).toMatchObject({ status: 'skipped', reason: 'deleted', changed: false })
    const createdLedger = record()
    applyLedgerImportRecord(createdLedger, source('new'), context, '2026-09-09T00:00:00.000Z')
    expect(createdLedger.entries[0].latestContentActor.initiator?.kind).toBe('agent')
  })
})
