import { describe, expect, it } from 'vitest'
import type { KernelAction } from '../../../shared/fork-heimdall/ledger-types'
import { createTickTrace, type WatcherTickTrace } from '../../../shared/fork-heimdall/tick-trace'
import { groupDecisionTraces } from './decision-trace-grouping'

const RUNNER: WatcherTickTrace['runner'] = {
  consecutiveErrors: 0,
  lastFullResyncAtMs: null,
  reconcileAgain: false
}

const ACTION: KernelAction = {
  kind: 'publish-fix',
  capability: 'fixChecks',
  visibility: 'external',
  contentIdentity: 'content',
  evidenceKey: 'evidence'
}

function watchingTrace(seq: number): WatcherTickTrace {
  const trace = createTickTrace(seq, seq * 1_000, RUNNER)
  trace.durationMs = seq * 10
  trace.exitPath = 'watching'
  trace.contentIdentity = 'content'
  trace.snapshot = { state: 'watching', checks: ['passed'] }
  trace.decision = {
    action: null,
    reason: 'nothing-to-do',
    considered: [{ phase: 'checks', reason: 'already-passed' }]
  }
  trace.declined = trace.decision.considered
  return trace
}

describe('decision trace grouping', () => {
  it('collapses consecutive unchanged ticks without mutating order and keeps the newest trace', () => {
    const older = watchingTrace(7)
    const newer = watchingTrace(8)
    const separated = watchingTrace(5)
    const traces = [older, separated, newer]

    const groups = groupDecisionTraces(traces)

    expect(traces.map((trace) => trace.seq)).toEqual([7, 5, 8])
    expect(
      groups.map((group) => [group.representative.seq, group.oldestTrace.seq, group.count])
    ).toEqual([
      [8, 7, 2],
      [5, 5, 1]
    ])
    expect(groups[0]?.representative).toBe(newer)
  })

  it('collapses folded approval gate revisions for the same complete scope', () => {
    const older = watchingTrace(10)
    const newer = watchingTrace(11)
    const approvalScope = {
      actionKind: 'publish-fix',
      contentIdentity: 'content',
      evidenceKey: 'evidence',
      preparedCommitSha: 'prepared'
    }
    older.gate = {
      verdict: 'hold',
      reason: 'awaiting-approval',
      escalation: {
        escalationId: 'revision-old',
        escalationKind: 'awaiting-approval',
        foldCount: 1,
        approvalScope
      }
    }
    newer.gate = {
      verdict: 'hold',
      reason: 'awaiting-approval',
      escalation: {
        escalationId: 'revision-new',
        escalationKind: 'awaiting-approval',
        foldCount: 7,
        approvalScope
      }
    }

    expect(groupDecisionTraces([older, newer])).toEqual([
      { representative: newer, oldestTrace: older, count: 2 }
    ])
  })

  const meaningfulDifferences: readonly [
    label: string,
    change: (older: WatcherTickTrace, newer: WatcherTickTrace) => void
  ][] = [
    [
      'action identity even when the action kind matches',
      (older, newer) => {
        older.decision = { action: { ...ACTION, contentIdentity: 'content-old' } }
        newer.decision = { action: { ...ACTION, contentIdentity: 'content-new' } }
      }
    ],
    [
      'decision reason',
      (older, newer) => {
        if (older.decision && !older.decision.action && 'reason' in older.decision) {
          older.decision.reason = 'reason-old'
        }
        if (newer.decision && !newer.decision.action && 'reason' in newer.decision) {
          newer.decision.reason = 'reason-new'
        }
      }
    ],
    [
      'gate reason',
      (older, newer) => {
        older.gate = { verdict: 'hold', reason: 'gate-old' }
        newer.gate = { verdict: 'hold', reason: 'gate-new' }
      }
    ],
    [
      'gate approval scope',
      (older, newer) => {
        older.gate = {
          verdict: 'hold',
          reason: 'awaiting-approval',
          escalation: {
            escalationId: 'escalation',
            escalationKind: 'awaiting-approval',
            foldCount: 1,
            approvalScope: {
              actionKind: 'publish-fix',
              contentIdentity: 'content-old',
              evidenceKey: 'evidence'
            }
          }
        }
        newer.gate = {
          verdict: 'hold',
          reason: 'awaiting-approval',
          escalation: {
            escalationId: 'escalation',
            escalationKind: 'awaiting-approval',
            foldCount: 2,
            approvalScope: {
              actionKind: 'publish-fix',
              contentIdentity: 'content-new',
              evidenceKey: 'evidence'
            }
          }
        }
      }
    ],
    [
      'error message',
      (older, newer) => {
        older.error = { message: 'failure-old' }
        newer.error = { message: 'failure-new' }
      }
    ],
    [
      'rendered snapshot',
      (older, newer) => {
        older.snapshot = { state: 'old' }
        newer.snapshot = { state: 'new' }
      }
    ]
  ]

  it.each(meaningfulDifferences)('does not merge ticks with a different %s', (_label, change) => {
    const older = watchingTrace(20)
    const newer = watchingTrace(21)
    change(older, newer)

    expect(groupDecisionTraces([older, newer])).toHaveLength(2)
  })
})
