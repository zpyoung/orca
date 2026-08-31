import { describe, expect, it } from 'vitest'
import {
  FORK_SESSION_HANDOFF_LINEAGE_CAP,
  FORK_SESSION_HANDOFF_LINEAGE_VERSION,
  type ForkSessionHandoffLineageFile
} from './session-lineage-types'

describe('session lineage schema', () => {
  it('pins the file version and bounded record capacity', () => {
    expect(FORK_SESSION_HANDOFF_LINEAGE_VERSION).toBe(1)
    expect(FORK_SESSION_HANDOFF_LINEAGE_CAP).toBe(500)
  })

  it('represents both directions with one record', () => {
    const file: ForkSessionHandoffLineageFile = {
      version: FORK_SESSION_HANDOFF_LINEAGE_VERSION,
      records: [
        {
          id: 'handoff-1',
          createdAt: 1_700_000_000_000,
          relationship: 'reviews',
          parent: {
            paneKey: 'parent-pane',
            agent: 'claude',
            providerSessionId: 'parent-session',
            transcriptPath: '/tmp/parent.jsonl',
            worktreeId: 'worktree-parent',
            title: 'Parent'
          },
          child: {
            paneKey: 'child-pane',
            agent: 'codex',
            providerSessionId: 'child-session',
            transcriptPath: null,
            worktreeId: 'worktree-child',
            title: 'Child',
            tabId: 'tab-child'
          }
        }
      ]
    }

    expect(file.records[0]).toMatchObject({
      relationship: 'reviews',
      parent: { paneKey: 'parent-pane' },
      child: { paneKey: 'child-pane', tabId: 'tab-child' }
    })
  })
})
