import { describe, expect, it } from 'vitest'
import type { LedgerEntry, WatcherLedger } from '../fork-heimdall/ledger-types'
import type { Snapshot } from '../fork-heimdall/snapshot'
import { parkEscalationId } from '../fork-heimdall/park-escalation-id'
import type { ObjectiveWorld } from './detail-types'
import { stopRungForBar } from './landing-ladder'
import { objectiveBarReachedPredicate, objectiveWorkerEscalationPredicate } from './stop-policy'

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
        revisions: [
          {
            id: 'revision-1',
            number: 1,
            status: 'approved',
            digest: 'plan-digest',
            createdByDispatchId: 'planner-dispatch',
            createdAtMs: 10,
            approvedAtMs: 20
          }
        ],
        nodes: [],
        verdicts: [],
        landing: [
          {
            rung: stopRungForBar(landingBar),
            revisionId: 'revision-1',
            contentIdentity: 'content-1',
            atMs: 90
          }
        ]
      },
      reports: [],
      budget: { wallClockActiveMs: null, turns: null },
      landingContext: {
        branch: null,
        headSha: null,
        worktreeContentDigest: null,
        pushTarget: null,
        hostedReview: null
      }
    }
  }
}

function ledger(entries: LedgerEntry[] = []): WatcherLedger {
  return { watcherId: 'watcher-1', entries }
}

describe('objective stop policy', () => {
  it.each([
    ['files-on-disk', 'files-on-disk landing bar reached'],
    ['committed-local-branch', 'committed-local-branch landing bar reached'],
    ['pushed-ref', 'pushed-ref landing bar reached'],
    ['hosted-review', 'hosted-review landing bar reached'],
    ['merged', 'hosted-review rung reached; handed off']
  ] as const)('declares the %s bar terminal at its stop rung', (bar, reason) => {
    expect(objectiveBarReachedPredicate.disposition).toBe('terminal')
    expect(objectiveBarReachedPredicate.evaluate(snapshot(bar), ledger())).toEqual({
      stop: true,
      reason,
      detail: 'content-1'
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
            },
            result: {
              kind: 'landing-recorded',
              naturalKey: {
                kind: 'landing-evidence',
                rung: 'files-on-disk',
                contentIdentity: 'content-1'
              },
              digest: 'landing-digest'
            }
          }
        ])
      )
    ).toMatchObject({ stop: true, reason: 'files-on-disk landing bar reached' })
  })

  it('ignores settled landing evidence from a stale revision', () => {
    const current = snapshot('files-on-disk')
    current.world.plan.landing = []
    expect(
      objectiveBarReachedPredicate.evaluate(
        current,
        ledger([
          {
            kind: 'attempt',
            eventId: 'event-stale-landing',
            watcherId: 'watcher-1',
            atMs: 101,
            origin: 'owner',
            class: 'fact',
            attemptId: 'attempt-stale-landing',
            fingerprint: 'fingerprint-stale-landing',
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
              revisionId: 'revision-old'
            },
            result: {
              kind: 'landing-recorded',
              naturalKey: {
                kind: 'landing-evidence',
                rung: 'files-on-disk',
                contentIdentity: 'content-1'
              },
              digest: 'landing-digest'
            }
          }
        ])
      )
    ).toEqual({ stop: false })
  })

  it('fires for just-landed push and review actions before projection refresh', () => {
    const pushed = snapshot('pushed-ref')
    pushed.world.plan.landing = []
    expect(
      objectiveBarReachedPredicate.evaluate(
        pushed,
        ledger([
          {
            kind: 'attempt',
            eventId: 'event-push',
            watcherId: 'watcher-1',
            atMs: 101,
            origin: 'owner',
            class: 'fact',
            attemptId: 'attempt-push',
            fingerprint: 'fingerprint-push',
            state: 'settled',
            effect: 'landed',
            action: {
              kind: 'push-ref',
              capability: 'land',
              visibility: 'external',
              contentIdentity: 'content-1',
              evidenceKey: 'pushed-ref:commit-1:origin/feature:before',
              rung: 'pushed-ref',
              revisionId: 'revision-1',
              branch: 'feature',
              remote: 'origin',
              commitSha: 'commit-1',
              expectedState: { target: 'origin/feature', before: 'before' }
            },
            result: {
              kind: 'push-recorded',
              naturalKey: {
                kind: 'push-ref',
                commitSha: 'commit-1',
                remote: 'origin',
                branch: 'feature'
              },
              remoteSha: 'commit-1'
            }
          }
        ])
      )
    ).toMatchObject({ stop: true, reason: 'pushed-ref landing bar reached' })

    const reviewed = snapshot('merged')
    reviewed.world.plan.landing = []
    expect(
      objectiveBarReachedPredicate.evaluate(
        reviewed,
        ledger([
          {
            kind: 'attempt',
            eventId: 'event-review',
            watcherId: 'watcher-1',
            atMs: 102,
            origin: 'owner',
            class: 'fact',
            attemptId: 'attempt-review',
            fingerprint: 'fingerprint-review',
            state: 'settled',
            effect: 'landed',
            action: {
              kind: 'open-hosted-review',
              capability: 'land',
              visibility: 'external',
              contentIdentity: 'content-1',
              evidenceKey: 'hosted-review:github:feature:commit-1',
              rung: 'hosted-review',
              revisionId: 'revision-1',
              branch: 'feature',
              base: 'main',
              headSha: 'commit-1',
              provider: 'github',
              expectedState: { target: 'github:repo-1:feature', before: 'no-review' }
            },
            result: {
              kind: 'review-recorded',
              naturalKey: {
                kind: 'open-hosted-review',
                provider: 'github',
                branch: 'feature',
                headSha: 'commit-1'
              },
              reviewNumber: 42,
              reviewUrl: 'https://github.com/acme/repo/pull/42'
            }
          }
        ])
      )
    ).toEqual({
      stop: true,
      reason: 'hosted-review rung reached; handed off',
      detail: 'content-1'
    })
  })

  it('uses the post-commit identity from a just-landed commit result', () => {
    const committed = snapshot('committed-local-branch')
    committed.world.plan.landing = []
    expect(
      objectiveBarReachedPredicate.evaluate(
        committed,
        ledger([
          {
            kind: 'attempt',
            eventId: 'event-commit',
            watcherId: 'watcher-1',
            atMs: 101,
            origin: 'owner',
            class: 'fact',
            attemptId: 'attempt-commit',
            fingerprint: 'fingerprint-commit',
            state: 'settled',
            effect: 'landed',
            action: {
              kind: 'commit-local-branch',
              capability: 'land',
              visibility: 'local',
              recovery: 'replay-safe',
              contentIdentity: 'content-1',
              evidenceKey: 'committed-local-branch:content-1',
              rung: 'committed-local-branch',
              revisionId: 'revision-1',
              branch: 'feature',
              headSha: 'head-before',
              worktreeContentDigest: 'worktree-digest',
              fromContentIdentity: 'content-1',
              attemptTrailer: 'committed-local-branch:content-1'
            },
            result: {
              kind: 'commit-recorded',
              naturalKey: {
                kind: 'commit-local-branch',
                revisionId: 'revision-1',
                fromContentIdentity: 'content-1'
              },
              commitSha: 'commit-1',
              contentIdentity: 'content-2',
              outsideTerritoryPaths: []
            }
          }
        ])
      )
    ).toEqual({
      stop: true,
      reason: 'committed-local-branch landing bar reached',
      detail: 'content-2'
    })
  })

  it('treats a projected higher rung as satisfying a re-armed lower bar', () => {
    const rearmed = snapshot('committed-local-branch')
    rearmed.world.plan.landing = [
      {
        rung: 'pushed-ref',
        revisionId: 'revision-1',
        contentIdentity: 'content-1',
        atMs: 90
      }
    ]
    expect(objectiveBarReachedPredicate.evaluate(rearmed, ledger())).toMatchObject({
      stop: true,
      reason: 'committed-local-branch landing bar reached'
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
            escalationId: 'park:watcher-1:stop-predicate:worker-escalation',
            escalationKind: 'park-stop-predicate',
            status: 'acknowledged',
            foldCount: 2
          }
        ])
      )
    ).toEqual({ stop: false })
  })

  it('reads back an acknowledgement written with the park escalation id the runner produces', () => {
    const acknowledged: LedgerEntry = {
      kind: 'escalation',
      eventId: 'event-ack',
      watcherId: 'watcher-1',
      atMs: 30,
      origin: 'owner',
      class: 'fact',
      escalationId: parkEscalationId('watcher-1', {
        kind: 'stop-predicate',
        predicateId: 'worker-escalation',
        reason: 'Agent exited unexpectedly'
      }),
      escalationKind: 'park-stop-predicate',
      status: 'acknowledged',
      foldCount: 2
    }

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
            payload: { type: 'escalation', subject: 'Agent exited unexpectedly', payload: {} }
          },
          acknowledged
        ])
      )
    ).toEqual({ stop: false })
  })
})
