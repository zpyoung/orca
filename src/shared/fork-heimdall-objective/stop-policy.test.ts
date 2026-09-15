import { describe, expect, it } from 'vitest'
import type { LedgerEntry, WatcherLedger } from '../fork-heimdall/ledger-types'
import type { Snapshot } from '../fork-heimdall/snapshot'
import type { ObjectiveWorld } from './detail-types'
import {
  objectiveAwaitingPhaseFourPredicate,
  objectiveBarReachedPredicate,
  objectiveWorkerEscalationPredicate
} from './stop-policy'

function snapshot(landingBar: ObjectiveWorld['contract']['landingBar']): Snapshot<ObjectiveWorld> {
  return {
    freshness: 'live',
    contentIdentity: 'content-1',
    observedAtMs: 100,
    world: {
      contract: {
        objectiveText: 'Objective',
        tier: 'standard',
        landingBar,
        maxConcurrency: 1,
        workspaceKind: 'git',
        writeTerritory: ['src/**'],
        roleAgents: {},
        sitterOverrides: {}
      },
      workspaceKind: 'git',
      plan: {
        revisions: [],
        nodes: [],
        verdicts: [],
        landing: [
          {
            rung: 'files-on-disk',
            revisionId: 'revision-1',
            contentIdentity: 'content-1',
            atMs: 90
          }
        ]
      },
      reports: [],
      budget: { wallClockActiveMs: null, turns: null }
    }
  }
}

function ledger(entries: LedgerEntry[] = []): WatcherLedger {
  return { watcherId: 'watcher-1', entries }
}

describe('objective stop policy', () => {
  it('declares the files-on-disk bar terminal', () => {
    expect(objectiveBarReachedPredicate.disposition).toBe('terminal')
    expect(
      objectiveBarReachedPredicate.evaluate(snapshot('files-on-disk'), ledger())
    ).toMatchObject({
      stop: true,
      reason: 'files-on-disk landing bar reached'
    })
    expect(
      objectiveAwaitingPhaseFourPredicate.evaluate(snapshot('files-on-disk'), ledger())
    ).toEqual({
      stop: false
    })
  })

  it('fires post-action from the fresh ledger before the store projection refreshes', () => {
    const beforeAction = snapshot('files-on-disk')
    beforeAction.world.plan.landing = []
    expect(
      objectiveBarReachedPredicate.evaluate(
        beforeAction,
        ledger([
          {
            kind: 'attempt',
            eventId: 'event-landing',
            watcherId: 'watcher-1',
            atMs: 101,
            origin: 'owner',
            class: 'fact',
            attemptId: 'attempt-landing',
            fingerprint: 'fingerprint-landing',
            state: 'settled',
            effect: 'landed',
            action: {
              kind: 'record-landing',
              capability: 'land',
              visibility: 'local',
              recovery: 'replay-safe',
              contentIdentity: 'content-1',
              evidenceKey: 'files-on-disk:content-1',
              rung: 'files-on-disk',
              revisionId: 'revision-1'
            }
          }
        ])
      )
    ).toMatchObject({ stop: true, reason: 'files-on-disk landing bar reached' })
  })

  it('parks at files on disk when a higher landing bar awaits Phase 4', () => {
    expect(objectiveAwaitingPhaseFourPredicate.disposition).toBeUndefined()
    expect(objectiveBarReachedPredicate.evaluate(snapshot('merged'), ledger())).toEqual({
      stop: false
    })
    expect(
      objectiveAwaitingPhaseFourPredicate.evaluate(snapshot('merged'), ledger())
    ).toMatchObject({
      stop: true,
      reason: 'files-on-disk reached; awaiting Phase 4 for merged'
    })
  })

  it('fires for a new worker escalation and reports its subject', () => {
    expect(
      objectiveWorkerEscalationPredicate.evaluate(
        snapshot('files-on-disk'),
        ledger([
          {
            kind: 'evidence',
            eventId: 'event-escalation',
            watcherId: 'watcher-1',
            atMs: 20,
            origin: 'owner',
            class: 'fact',
            evidenceKind: 'orchestration-mailbox',
            payload: {
              type: 'escalation',
              subject: 'Need a human decision',
              body: 'The generated API conflicts with the contract',
              payload: { dispatchId: 'dispatch-1' }
            }
          }
        ])
      )
    ).toEqual({
      stop: true,
      reason: 'Need a human decision',
      detail: 'The generated API conflicts with the contract'
    })
  })

  it('does not re-fire an escalation older than its latest park acknowledgement', () => {
    expect(
      objectiveWorkerEscalationPredicate.evaluate(
        snapshot('files-on-disk'),
        ledger([
          {
            kind: 'evidence',
            eventId: 'event-escalation',
            watcherId: 'watcher-1',
            atMs: 20,
            origin: 'owner',
            class: 'fact',
            evidenceKind: 'orchestration-mailbox',
            payload: { type: 'escalation', subject: 'Old escalation', payload: {} }
          },
          {
            kind: 'escalation',
            eventId: 'event-ack',
            watcherId: 'watcher-1',
            atMs: 30,
            origin: 'owner',
            class: 'fact',
            escalationId: 'park-stop-predicate:worker-escalation',
            escalationKind: 'park-stop-predicate:worker-escalation',
            status: 'acknowledged',
            foldCount: 2
          }
        ])
      )
    ).toEqual({ stop: false })
  })
})
