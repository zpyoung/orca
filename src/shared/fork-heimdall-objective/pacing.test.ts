import { describe, expect, it } from 'vitest'
import type { LedgerEntry, WatcherLedger } from '../fork-heimdall/ledger-types'
import type { Snapshot } from '../fork-heimdall/snapshot'
import type { ObjectiveWorld } from './detail-types'
import { deriveObjectiveBudgetBucket, paceObjective } from './pacing'

function ledger(entries: LedgerEntry[] = []): WatcherLedger {
  return { watcherId: 'watcher-1', entries }
}

function worldSnapshot(overrides: Partial<ObjectiveWorld['plan']> = {}): Snapshot<ObjectiveWorld> {
  return {
    freshness: 'live',
    contentIdentity: 'content-1',
    observedAtMs: 100,
    world: {
      contract: {
        objectiveText: 'Objective',
        tier: 'express',
        landingBar: 'files-on-disk',
        maxConcurrency: 1,
        workspaceKind: 'git',
        writeTerritory: ['src/**'],
        roleAgents: {},
        sitterOverrides: {}
      },
      workspaceKind: 'git',
      plan: { revisions: [], nodes: [], verdicts: [], landing: [], ...overrides },
      reports: [],
      budget: { wallClockActiveMs: null, turns: 10 }
    }
  }
}

function turns(count: number): LedgerEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: 'turn' as const,
    eventId: `event-turn-${index}`,
    watcherId: 'watcher-1',
    atMs: index,
    origin: 'owner' as const,
    class: 'fact' as const,
    dispatchKind: 'child' as const,
    dispatchId: `dispatch-${index}`
  }))
}

describe('objective pacing', () => {
  it('derives deterministic budget buckets from policy and ledger facts', () => {
    const policy = { wallClockActiveMs: null, turns: 10 }
    expect(deriveObjectiveBudgetBucket(ledger(turns(4)), policy)).toBe('plenty')
    expect(deriveObjectiveBudgetBucket(ledger(turns(5)), policy)).toBe('tight')
    expect(deriveObjectiveBudgetBucket(ledger(turns(9)), policy)).toBe('nearly-spent')
    expect(deriveObjectiveBudgetBucket(ledger(turns(10)), policy)).toBe('spent')
  })

  it('paces rapidly while a draft needs local activation', () => {
    const snapshot = worldSnapshot({
      revisions: [
        {
          id: 'revision-1',
          number: 1,
          status: 'draft',
          digest: 'digest',
          createdByDispatchId: 'dispatch-planner',
          createdAtMs: 10,
          approvedAtMs: null
        }
      ]
    })
    expect(paceObjective(snapshot, ledger())).toBe('rapid')
  })

  it('uses active pacing while an objective worker is in flight', () => {
    const entries: LedgerEntry[] = [
      {
        kind: 'attempt',
        eventId: 'event-attempt',
        watcherId: 'watcher-1',
        atMs: 10,
        origin: 'owner',
        class: 'fact',
        attemptId: 'attempt-1',
        fingerprint: 'fingerprint-1',
        state: 'running',
        action: {
          kind: 'dispatch-planner',
          capability: 'plan',
          visibility: 'local',
          contentIdentity: 'content-1',
          evidenceKey: 'plan:1',
          revisionNumber: 1,
          reason: 'initial'
        },
        dispatch: { spec: 'Plan', taskKey: 'planner', dispatchKind: 'child' },
        dispatchId: 'dispatch-planner'
      }
    ]
    expect(paceObjective(worldSnapshot(), ledger(entries))).toBe('active')
  })

  it('uses idle pacing beside an unresolved approval gate', () => {
    const entries: LedgerEntry[] = [
      {
        kind: 'escalation',
        eventId: 'event-gate',
        watcherId: 'watcher-1',
        atMs: 10,
        origin: 'owner',
        class: 'fact',
        escalationId: 'gate-1',
        escalationKind: 'awaiting-approval',
        status: 'open',
        foldCount: 1
      }
    ]
    expect(paceObjective(worldSnapshot(), ledger(entries))).toBe('idle')
  })

  it('stops polling after files-on-disk evidence at the current identity', () => {
    const snapshot = worldSnapshot({
      landing: [
        { rung: 'files-on-disk', revisionId: 'revision-1', contentIdentity: 'content-1', atMs: 20 }
      ]
    })
    expect(paceObjective(snapshot, ledger())).toBe('stopped')
  })
})
