import { describe, expect, it } from 'vitest'
import type { EvidenceEntry, WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import type { ObjectiveWorld } from '../../../shared/fork-heimdall-objective/detail-types'
import {
  computeJudgmentIdentity,
  type ComputedJudgmentIdentity,
  type JudgmentState
} from './identity'
import { expandJudgmentState } from './state-normalization'

const watcherId = 'identity-watcher'

function world(): ObjectiveWorld {
  return {
    contract: {
      objectiveText: 'Implement the objective',
      tier: 'standard',
      landingBar: 'files-on-disk',
      maxConcurrency: 1,
      workspaceKind: 'folder',
      writeTerritory: ['**'],
      roleAgents: {},
      sitterOverrides: {}
    },
    workspaceKind: 'folder',
    plan: { revisions: [], nodes: [], verdicts: [], landing: [] },
    reports: [],
    budget: { wallClockActiveMs: null, turns: null },
    capabilities: { plan: 'gated', implement: 'on', review: 'on', check: 'on', land: 'off' },
    landingContext: {
      branch: null,
      headSha: null,
      worktreeContentDigest: null,
      pushTarget: null,
      hostedReview: null
    }
  }
}

function escalation(
  eventId: string,
  messageId: string,
  sequence: number,
  dispatchId: string,
  text: string
): EvidenceEntry {
  return {
    eventId,
    watcherId,
    atMs: sequence * 100,
    origin: 'owner',
    class: 'fact',
    kind: 'evidence',
    evidenceKind: 'orchestration-mailbox',
    source: { kind: 'orchestration', sequence, messageId },
    payload: {
      type: 'escalation',
      subject: 'Blocked',
      body: text,
      payload: { dispatchId }
    }
  }
}

function ledger(entries: WatcherLedger['entries']): WatcherLedger {
  return { watcherId, entries }
}

function expanded(result: ComputedJudgmentIdentity): JudgmentState {
  return expandJudgmentState<JudgmentState>(result.state)
}

describe('judgment state identity', () => {
  it('changes when an escalation is consumed and when identical text arrives under a new message', () => {
    const initial = escalation(
      'event-1',
      'message-1',
      1,
      'dispatch-1',
      'Optional check unavailable'
    )
    const before = computeJudgmentIdentity('content-1', world(), ledger([initial]))
    expect(expanded(before).ledger.latestEscalation).toMatchObject({
      subjectId: 'message-1',
      body: 'Optional check unavailable'
    })

    const consumed: WatcherLedger['entries'][number] = {
      eventId: 'consumed-1',
      watcherId,
      atMs: 200,
      origin: 'owner',
      class: 'fact',
      kind: 'evidence',
      evidenceKind: 'worker-escalation-consumed',
      payload: { messageId: 'message-1' }
    }
    const afterConsumption = computeJudgmentIdentity(
      'content-1',
      world(),
      ledger([initial, consumed])
    )
    expect(expanded(afterConsumption).ledger.latestEscalation).toBeNull()
    expect(afterConsumption.stateIdentity).not.toBe(before.stateIdentity)

    const repeated = escalation(
      'event-2',
      'message-2',
      3,
      'dispatch-1',
      'Optional check unavailable'
    )
    const afterRepeat = computeJudgmentIdentity(
      'content-1',
      world(),
      ledger([initial, consumed, repeated])
    )
    expect(expanded(afterRepeat).ledger.latestEscalation).toMatchObject({
      subjectId: 'message-2',
      body: 'Optional check unavailable'
    })
    expect(afterRepeat.stateIdentity).not.toBe(afterConsumption.stateIdentity)
  })

  it('marks only the latest unconsumed escalation while ignoring timestamp and delivery churn', () => {
    const first = escalation('event-1', 'message-1', 1, 'dispatch-1', 'First blocker')
    const latest = escalation('event-2', 'message-2', 2, 'dispatch-2', 'Latest blocker')
    const projected = computeJudgmentIdentity('content-1', world(), ledger([first, latest]))
    expect(expanded(projected).ledger.latestEscalation).toMatchObject({
      subjectId: 'message-2',
      body: 'Latest blocker',
      payload: { dispatchId: 'dispatch-2' }
    })
    expect(expanded(projected).ledger.reports).toEqual([])

    const duplicate = {
      ...latest,
      eventId: 'event-3',
      atMs: 9_999,
      source: {
        kind: 'orchestration' as const,
        sequence: 999,
        messageId: 'message-2',
        deliveryId: 'delivery-churn'
      }
    }
    const churned = computeJudgmentIdentity(
      'content-1',
      world(),
      ledger([first, latest, duplicate])
    )
    expect(churned.projectionDigest).toBe(projected.projectionDigest)
  })

  it('keeps projection identity separate from workspace content identity', () => {
    const current = ledger([])
    const first = computeJudgmentIdentity('content-1', world(), current)
    const second = computeJudgmentIdentity('content-2', world(), current)
    expect(second.projectionDigest).toBe(first.projectionDigest)
    expect(second.stateIdentity).not.toBe(first.stateIdentity)
  })
})
