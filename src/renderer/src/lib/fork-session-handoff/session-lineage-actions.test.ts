import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ForkSessionHandoffLineageRecord } from '../../../../shared/fork-session-handoff/session-lineage-types'
import {
  enrichSessionLineage,
  getSessionLineageSnapshot,
  listSessionLineage,
  recordSessionLineage,
  resetSessionLineageCacheForTests,
  subscribeSessionLineage
} from './session-lineage-actions'

const api = vi.hoisted(() => ({
  lineageList: vi.fn(),
  lineageRecord: vi.fn(),
  lineageEnrich: vi.fn()
}))

vi.mock('./session-handoff-renderer-api', () => ({
  getForkSessionHandoffApi: () => api
}))

function makeRecord(
  id: string,
  createdAt: number,
  child: Partial<ForkSessionHandoffLineageRecord['child']> = {}
): ForkSessionHandoffLineageRecord {
  return {
    id,
    createdAt,
    relationship: 'continues',
    parent: {
      paneKey: 'parent-tab:11111111-1111-4111-8111-111111111111',
      agent: 'claude',
      providerSessionId: 'parent-provider',
      transcriptPath: '/tmp/parent.jsonl',
      worktreeId: 'parent-worktree',
      title: 'Parent'
    },
    child: {
      paneKey: null,
      agent: 'codex',
      providerSessionId: null,
      transcriptPath: null,
      worktreeId: 'child-worktree',
      title: 'Child',
      tabId: 'child-tab',
      ...child
    }
  }
}

beforeEach(() => {
  resetSessionLineageCacheForTests()
  vi.clearAllMocks()
  api.lineageList.mockResolvedValue([])
  api.lineageRecord.mockResolvedValue(undefined)
  api.lineageEnrich.mockResolvedValue(undefined)
})

describe('session lineage renderer actions', () => {
  it('loads once, shares an in-flight request, and caches newest first', async () => {
    const older = makeRecord('older', 1)
    const newer = makeRecord('newer', 2)
    api.lineageList.mockResolvedValue([older, newer])

    const [first, second] = await Promise.all([listSessionLineage(), listSessionLineage()])

    expect(api.lineageList).toHaveBeenCalledTimes(1)
    expect(first).toEqual([newer, older])
    expect(second).toBe(first)
    expect(await listSessionLineage()).toBe(first)
  })

  it('writes a record through to the loaded cache and notifies subscribers', async () => {
    const existing = makeRecord('existing', 1)
    const added = makeRecord('added', 2)
    api.lineageList.mockResolvedValue([existing])
    const listener = vi.fn()
    const unsubscribe = subscribeSessionLineage(listener)

    await recordSessionLineage(added)

    expect(api.lineageRecord).toHaveBeenCalledWith(added)
    expect(getSessionLineageSnapshot()).toEqual([added, existing])
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('enriches null child identity fields once and writes through to the cache', async () => {
    const record = makeRecord('record', 1)
    api.lineageList.mockResolvedValue([record])

    await enrichSessionLineage({
      recordId: record.id,
      paneKey: 'child-tab:22222222-2222-4222-8222-222222222222',
      providerSessionId: 'child-provider'
    })
    await enrichSessionLineage({
      recordId: record.id,
      paneKey: 'replacement-pane',
      providerSessionId: 'replacement-provider'
    })

    expect(api.lineageEnrich).toHaveBeenCalledTimes(1)
    expect(api.lineageEnrich).toHaveBeenCalledWith({
      recordId: record.id,
      paneKey: 'child-tab:22222222-2222-4222-8222-222222222222',
      providerSessionId: 'child-provider'
    })
    expect(getSessionLineageSnapshot()[0]?.child).toMatchObject({
      paneKey: 'child-tab:22222222-2222-4222-8222-222222222222',
      providerSessionId: 'child-provider'
    })
  })

  it('coalesces concurrent enrichment through the idempotent cache check', async () => {
    const record = makeRecord('record', 1)
    api.lineageList.mockResolvedValue([record])
    const patch = {
      recordId: record.id,
      paneKey: 'child-tab:22222222-2222-4222-8222-222222222222'
    }

    await Promise.all([enrichSessionLineage(patch), enrichSessionLineage(patch)])

    expect(api.lineageEnrich).toHaveBeenCalledTimes(1)
  })

  it('keeps the cached identity unchanged when best-effort enrichment fails', async () => {
    const record = makeRecord('record', 1)
    api.lineageList.mockResolvedValue([record])
    api.lineageEnrich.mockRejectedValue(new Error('unavailable'))

    await expect(
      enrichSessionLineage({ recordId: record.id, paneKey: 'child-pane' })
    ).resolves.toBeUndefined()

    expect(getSessionLineageSnapshot()[0]?.child.paneKey).toBeNull()
  })
})
