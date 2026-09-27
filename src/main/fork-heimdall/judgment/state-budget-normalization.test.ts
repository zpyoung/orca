import { describe, expect, it } from 'vitest'
import type { WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import type { ObjectiveWorld } from '../../../shared/fork-heimdall-objective/detail-types'
import { computeJudgmentIdentity } from './identity'
import { ledger as buildLedger, world as buildWorld } from './judgment-test-world'
import { expandJudgmentState } from './state-normalization'
import { stableJson } from './state-projection'

const watcherId = 'normalization-budget-watcher'

function world(): ObjectiveWorld {
  return buildWorld({ withCapabilities: true })
}

function ledger(entries: WatcherLedger['entries']): WatcherLedger {
  return buildLedger(watcherId, entries)
}

function repeatedHistory(text: string): WatcherLedger['entries'] {
  return [
    {
      eventId: 'shared-attempt',
      watcherId,
      atMs: 1,
      origin: 'owner',
      class: 'fact',
      kind: 'attempt',
      attemptId: 'shared-attempt',
      fingerprint: 'shared-fingerprint',
      action: {
        kind: 'dispatch-node',
        capability: 'implement',
        visibility: 'local',
        contentIdentity: 'content-1',
        evidenceKey: 'shared-evidence'
      },
      state: 'settled',
      effect: 'not-landed',
      reason: text,
      dispatchId: 'shared-dispatch'
    },
    {
      eventId: 'shared-report',
      watcherId,
      atMs: 2,
      origin: 'owner',
      class: 'fact',
      kind: 'evidence',
      evidenceKind: 'orchestration-mailbox',
      payload: {
        type: 'worker_done',
        body: text,
        payload: { dispatchId: 'shared-dispatch', outcome: 'succeeded' }
      }
    }
  ]
}

describe('normalized judgment state budget', () => {
  it('leaves an under-budget no-savings projection and identity untouched', () => {
    const full = computeJudgmentIdentity('content-1', world(), ledger([]))
    const bounded = computeJudgmentIdentity('content-1', world(), ledger([]), {
      maxStateBytes: full.serializedBytes
    })

    expect(full.normalization).toBeNull()
    expect(bounded.serializedState).toBe(full.serializedState)
    expect(bounded.stateIdentity).toBe(full.stateIdentity)
    expect(bounded.truncation).toBeNull()
    expect(bounded.omittedQuestionSubjectIds).toEqual([])
  })

  it('fits repeated full state through normalization before dropping history', () => {
    const repeated = 'same exact worker context with unicode 界 and escaped \\ content '.repeat(80)
    const entries = repeatedHistory(repeated)
    const full = computeJudgmentIdentity('content-1', world(), ledger(entries))
    const originalBytes = Buffer.byteLength(stableJson(expandJudgmentState(full.state)), 'utf8')

    expect(full.normalization).not.toBeNull()
    expect(full.serializedBytes).toBeLessThan(originalBytes)
    const bounded = computeJudgmentIdentity('content-1', world(), ledger(entries), {
      maxStateBytes: full.serializedBytes
    })
    expect(bounded.fitsStateBudget).toBe(true)
    expect(bounded.truncation).toBeNull()
    expect(bounded.stateIdentity).toBe(full.stateIdentity)
    expect(bounded.serializedState).toBe(JSON.stringify(bounded.state))
  })
})
