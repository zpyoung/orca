import { describe, expect, it } from 'vitest'
import type { LedgerEntry, WatcherLedger } from '../fork-heimdall/ledger-types'
import type { Snapshot } from '../fork-heimdall/snapshot'
import type { ObjectiveWorld } from './detail-types'
import { stopRungForBar } from './landing-ladder'
import {
  objectiveBarReachedPredicate,
  objectiveInfraRetryExhaustedPredicate,
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

  function mailboxEscalation(input: {
    eventId: string
    atMs: number
    messageId?: string
    subject?: string
    body?: string
  }): LedgerEntry {
    return {
      kind: 'evidence',
      eventId: input.eventId,
      watcherId: 'watcher-1',
      atMs: input.atMs,
      origin: 'owner',
      class: 'fact',
      evidenceKind: 'orchestration-mailbox',
      ...(input.messageId
        ? {
            source: {
              kind: 'orchestration',
              sequence: input.atMs,
              messageId: input.messageId
            }
          }
        : {}),
      payload: {
        type: 'escalation',
        subject: input.subject ?? 'Need a human decision',
        ...(input.body ? { body: input.body } : {}),
        payload: { dispatchId: 'dispatch-1' }
      }
    }
  }

  function consumedMarker(eventId: string, atMs: number, messageId: string): LedgerEntry {
    return {
      kind: 'evidence',
      eventId,
      watcherId: 'watcher-1',
      atMs,
      origin: 'owner',
      class: 'fact',
      evidenceKind: 'worker-escalation-consumed',
      payload: { messageId }
    }
  }

  it('fires for a new worker escalation and reports its subject and message id', () => {
    expect(
      objectiveWorkerEscalationPredicate.evaluate(
        snapshot('files-on-disk'),
        ledger([
          mailboxEscalation({
            eventId: 'event-escalation',
            atMs: 20,
            messageId: 'message-1',
            body: 'The generated API conflicts with the contract'
          })
        ])
      )
    ).toEqual({
      stop: true,
      reason: 'Need a human decision',
      detail: 'message-1'
    })
  })

  it('fires on crash-recovery from durable mailbox evidence with no marker written yet', () => {
    // simulates a crash between the mailbox drain append and the park that would mark it consumed
    const durableEvidence = ledger([
      mailboxEscalation({ eventId: 'event-escalation', atMs: 20, messageId: 'message-1' })
    ])
    expect(
      objectiveWorkerEscalationPredicate.evaluate(snapshot('files-on-disk'), durableEvidence)
    ).toMatchObject({ stop: true })
  })

  it('does not re-fire once a park has consumed the escalation message', () => {
    expect(
      objectiveWorkerEscalationPredicate.evaluate(
        snapshot('files-on-disk'),
        ledger([
          mailboxEscalation({ eventId: 'event-escalation', atMs: 20, messageId: 'message-1' }),
          consumedMarker('event-consumed', 30, 'message-1')
        ])
      )
    ).toEqual({ stop: false })
  })

  it('fires for a new escalation message that arrives after an earlier one was consumed', () => {
    expect(
      objectiveWorkerEscalationPredicate.evaluate(
        snapshot('files-on-disk'),
        ledger([
          mailboxEscalation({ eventId: 'event-escalation-1', atMs: 20, messageId: 'message-1' }),
          consumedMarker('event-consumed', 30, 'message-1'),
          mailboxEscalation({ eventId: 'event-escalation-2', atMs: 40, messageId: 'message-2' })
        ])
      )
    ).toEqual({
      stop: true,
      reason: 'Need a human decision',
      detail: 'message-2'
    })
  })
})

describe('objective infra/environment retry exhaustion', () => {
  function withNode(): Snapshot<ObjectiveWorld> {
    const snap = snapshot('files-on-disk')
    snap.world.plan.nodes = [
      {
        revisionId: 'revision-1',
        taskKey: 'core',
        deps: [],
        orchestrationTaskId: null,
        dispatchId: null,
        state: 'pending',
        criteria: []
      }
    ]
    return snap
  }

  function dispatchAttempt(
    id: string,
    evidenceKey: string,
    retryOf: string | undefined,
    failureClass: 'infra' | 'environment' | 'criteria'
  ): LedgerEntry {
    return {
      kind: 'attempt',
      eventId: `event-${id}`,
      watcherId: 'watcher-1',
      atMs: 10,
      origin: 'owner',
      class: 'fact',
      attemptId: id,
      fingerprint: `fingerprint-${id}`,
      state: 'settled',
      effect: 'not-landed',
      failureClass,
      action: {
        kind: 'dispatch-node',
        capability: 'implement',
        visibility: 'local',
        contentIdentity: 'content-1',
        evidenceKey,
        revisionId: 'revision-1',
        taskKey: 'core',
        depsOrchestrationIds: [],
        ...(retryOf === undefined ? {} : { retryOf })
      }
    }
  }

  it('declares the predicate a park, not a terminal stop', () => {
    expect(objectiveInfraRetryExhaustedPredicate.disposition).toBe('park')
  })

  it('does not fire before the redispatch cap is reached', () => {
    const withOneFailure = ledger([
      dispatchAttempt('attempt-1', 'revision-1:core', undefined, 'infra')
    ])
    expect(objectiveInfraRetryExhaustedPredicate.evaluate(withNode(), withOneFailure)).toEqual({
      stop: false
    })
  })

  it('parks once a node has exhausted its infra/environment redispatch cap', () => {
    const exhausted = ledger([
      dispatchAttempt('attempt-1', 'revision-1:core', undefined, 'infra'),
      dispatchAttempt('attempt-2', 'revision-1:core:r0', 'revision-1:core', 'environment'),
      dispatchAttempt('attempt-3', 'revision-1:core:r1', 'revision-1:core', 'infra')
    ])
    expect(objectiveInfraRetryExhaustedPredicate.evaluate(withNode(), exhausted)).toEqual({
      stop: true,
      reason: 'core exhausted 2 infra/environment redispatches (last: infra)',
      detail: 'core'
    })
  })

  it('does not fire for a criteria failure regardless of retry count', () => {
    const criteriaFailure = ledger([
      dispatchAttempt('attempt-1', 'revision-1:core', undefined, 'criteria')
    ])
    expect(objectiveInfraRetryExhaustedPredicate.evaluate(withNode(), criteriaFailure)).toEqual({
      stop: false
    })
  })
})
