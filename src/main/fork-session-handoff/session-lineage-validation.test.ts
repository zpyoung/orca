import { describe, expect, it } from 'vitest'
import type { ForkSessionHandoffLineageRecord } from '../../shared/fork-session-handoff/session-lineage-types'
import {
  parseForkSessionHandoffLineageEnrichment,
  parseForkSessionHandoffLineageFile,
  parseForkSessionHandoffLineageRecord
} from './session-lineage-validation'

function recordFixture(): ForkSessionHandoffLineageRecord {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    createdAt: 1,
    relationship: 'continues',
    parent: {
      paneKey: 'parent-pane',
      agent: 'claude',
      providerSessionId: 'parent-provider',
      transcriptPath: '/tmp/transcript.jsonl',
      worktreeId: 'worktree-1',
      title: 'Parent'
    },
    child: {
      paneKey: null,
      agent: 'codex',
      providerSessionId: null,
      transcriptPath: null,
      worktreeId: 'worktree-1',
      title: null,
      tabId: 'tab-1'
    }
  }
}

describe('session lineage validation', () => {
  it('sanitizes records and rejects malformed nested identities', () => {
    expect(
      parseForkSessionHandoffLineageRecord({ ...recordFixture(), extra: 'discarded' })
    ).toEqual(recordFixture())
    expect(
      parseForkSessionHandoffLineageRecord({
        ...recordFixture(),
        parent: { ...recordFixture().parent, agent: 'unknown-agent' }
      })
    ).toBeNull()
    expect(
      parseForkSessionHandoffLineageRecord({
        ...recordFixture(),
        child: { ...recordFixture().child, tabId: 42 }
      })
    ).toBeNull()
  })

  it('rejects a file when its version or records array is invalid', () => {
    expect(parseForkSessionHandoffLineageFile({ version: 1, records: [recordFixture()] })).toEqual([
      recordFixture()
    ])
    expect(parseForkSessionHandoffLineageFile({ version: 2, records: [] })).toBeNull()
    expect(parseForkSessionHandoffLineageFile({ version: 1, records: {} })).toBeNull()
  })

  it('drops only the unreadable records so one bad entry cannot erase the history', () => {
    expect(
      parseForkSessionHandoffLineageFile({
        version: 1,
        records: [{ ...recordFixture(), createdAt: Number.NaN }, recordFixture()]
      })
    ).toEqual([recordFixture()])
  })

  it('requires an id and at least one useful enrichment field', () => {
    const recordId = recordFixture().id
    expect(parseForkSessionHandoffLineageEnrichment({ recordId, paneKey: 'pane-1' })).toEqual({
      recordId,
      paneKey: 'pane-1'
    })
    expect(parseForkSessionHandoffLineageEnrichment({ recordId, paneKey: null })).toBeNull()
    expect(
      parseForkSessionHandoffLineageEnrichment({ recordId: 'not-a-uuid', paneKey: 'pane-1' })
    ).toBeNull()
  })
})
