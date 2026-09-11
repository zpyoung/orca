import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ForkSessionHandoffLineageRecord } from '../../shared/fork-session-handoff/session-lineage-types'
import { registerForkSessionHandoffHandlers } from './session-lineage-ipc'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/user-data') },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
  }
}))

function recordFixture(): ForkSessionHandoffLineageRecord {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    createdAt: 1,
    relationship: 'branches-from',
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

describe('registerForkSessionHandoffHandlers', () => {
  const store = {
    list: vi.fn(),
    record: vi.fn(),
    enrich: vi.fn()
  }

  beforeEach(() => {
    handlers.clear()
    store.list.mockReset()
    store.record.mockReset()
    store.enrich.mockReset()
    registerForkSessionHandoffHandlers(store)
  })

  it('registers and forwards the list operation', async () => {
    store.list.mockResolvedValue([recordFixture()])

    await expect(handlers.get('forkSessionHandoff:lineageList')?.({})).resolves.toEqual([
      recordFixture()
    ])
  })

  it('validates and sanitizes records before storage', async () => {
    const record = { ...recordFixture(), rendererOnly: true }

    await handlers.get('forkSessionHandoff:lineageRecord')?.({}, record)

    expect(store.record).toHaveBeenCalledWith(recordFixture())
  })

  it('rejects malformed records at the main-process boundary', async () => {
    const malformed = {
      ...recordFixture(),
      child: { ...recordFixture().child, providerSessionId: 42 }
    }

    await expect(handlers.get('forkSessionHandoff:lineageRecord')?.({}, malformed)).rejects.toThrow(
      'Invalid session handoff lineage record.'
    )
    expect(store.record).not.toHaveBeenCalled()
  })

  it('validates enrichment and forwards only identity fields', async () => {
    const args = {
      recordId: recordFixture().id,
      paneKey: 'pane-2',
      rendererOnly: true
    }

    await handlers.get('forkSessionHandoff:lineageEnrich')?.({}, args)

    expect(store.enrich).toHaveBeenCalledWith({
      recordId: recordFixture().id,
      paneKey: 'pane-2'
    })
  })

  it('rejects enrichment with no useful identity value', async () => {
    await expect(
      handlers.get('forkSessionHandoff:lineageEnrich')?.(
        {},
        {
          recordId: recordFixture().id,
          paneKey: null,
          providerSessionId: null
        }
      )
    ).rejects.toThrow('Invalid session handoff lineage enrichment.')
    expect(store.enrich).not.toHaveBeenCalled()
  })
})
