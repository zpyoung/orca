import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ForkSessionHandoffLineageRecord } from '../../shared/fork-session-handoff/session-lineage-types'
import { buildForkSessionHandoffApi } from './session-handoff-preload-api'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('electron', () => ({ ipcRenderer: { invoke } }))

function recordFixture(): ForkSessionHandoffLineageRecord {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    createdAt: 1,
    relationship: 'continues',
    parent: {
      paneKey: 'parent-pane',
      agent: 'claude',
      providerSessionId: 'parent-provider',
      transcriptPath: '/tmp/parent.jsonl',
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

describe('buildForkSessionHandoffApi', () => {
  beforeEach(() => {
    invoke.mockReset()
  })

  it('invokes the lineage list channel', async () => {
    invoke.mockResolvedValue([recordFixture()])

    await expect(buildForkSessionHandoffApi().lineageList()).resolves.toEqual([recordFixture()])

    expect(invoke).toHaveBeenCalledWith('forkSessionHandoff:lineageList')
  })

  it('invokes the lineage record channel with the record', async () => {
    await buildForkSessionHandoffApi().lineageRecord(recordFixture())

    expect(invoke).toHaveBeenCalledWith('forkSessionHandoff:lineageRecord', recordFixture())
  })

  it('invokes the lineage enrich channel with the child identity patch', async () => {
    const args = {
      recordId: recordFixture().id,
      paneKey: 'child-pane',
      providerSessionId: 'child-provider'
    }

    await buildForkSessionHandoffApi().lineageEnrich(args)

    expect(invoke).toHaveBeenCalledWith('forkSessionHandoff:lineageEnrich', args)
  })

  it('invokes the transcript probe channel with the source identity', async () => {
    const request = {
      agent: 'claude',
      sessionId: 'session-1',
      transcriptPath: '/tmp/parent.jsonl',
      paneKey: 'tab-1:leaf-1',
      workspacePath: '/workspace/repo',
      connectionId: null
    }
    invoke.mockResolvedValue({
      outcome: 'found',
      transcriptPath: '/tmp/parent.jsonl',
      provenance: 'reported'
    })

    await expect(buildForkSessionHandoffApi().resolveTranscript(request)).resolves.toEqual({
      outcome: 'found',
      transcriptPath: '/tmp/parent.jsonl',
      provenance: 'reported'
    })

    expect(invoke).toHaveBeenCalledWith('forkSessionHandoff:resolveTranscript', request)
  })
})
