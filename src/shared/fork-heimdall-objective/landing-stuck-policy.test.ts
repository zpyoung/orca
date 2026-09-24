import { describe, expect, it } from 'vitest'
import { evaluateStopPredicates } from '../fork-heimdall/stop-policy'
import type { LedgerEntry } from '../fork-heimdall/ledger-types'
import { ownerDeviationEscalationId } from '../fork-heimdall/owner/deviation'
import { objectiveLandingFailedDeviation } from './deviation-context'
import { attempt, ledger, projection, snapshot } from './decision-test-harness'
import type { ObjectiveAction } from './objective-actions'
import {
  OBJECTIVE_LANDING_STUCK_WINDOW_MS,
  objectiveLandingStuckPredicate
} from './landing-stuck-policy'
import { OBJECTIVE_STOP_PREDICATES, objectiveBarReachedPredicate } from './stop-policy'

const CONTENT_IDENTITY = 'content-current'
const REVIEW_ACTION: ObjectiveAction = {
  kind: 'open-hosted-review',
  capability: 'land',
  visibility: 'external',
  contentIdentity: CONTENT_IDENTITY,
  evidenceKey: 'hosted-review:github:feature/objective:head-current',
  rung: 'hosted-review',
  revisionId: 'revision-1',
  branch: 'feature/objective',
  base: 'main',
  headSha: 'head-current',
  provider: 'github',
  expectedState: { target: 'github:repo-1:feature/objective', before: 'no-review' }
}
const PUSH_ACTION: ObjectiveAction = {
  kind: 'push-ref',
  capability: 'land',
  visibility: 'external',
  contentIdentity: CONTENT_IDENTITY,
  evidenceKey: 'pushed-ref:commit-1:origin/feature/objective:before',
  rung: 'pushed-ref',
  revisionId: 'revision-1',
  branch: 'feature/objective',
  remote: 'origin',
  commitSha: 'commit-1',
  expectedState: { target: 'origin/feature/objective', before: 'before' }
}

const COMMIT_ACTION: ObjectiveAction = {
  kind: 'commit-local-branch',
  capability: 'land',
  visibility: 'local',
  recovery: 'replay-safe',
  contentIdentity: CONTENT_IDENTITY,
  evidenceKey: 'committed-local-branch:content-current',
  rung: 'committed-local-branch',
  revisionId: 'revision-1',
  branch: 'feature/objective',
  headSha: 'head-current',
  worktreeContentDigest: 'worktree-digest',
  fromContentIdentity: CONTENT_IDENTITY,
  attemptTrailer: 'committed-local-branch:content-current'
}

function snapshotAt(observedAtMs: number, plan = projection()) {
  return { ...snapshot(plan, {}, CONTENT_IDENTITY), observedAtMs }
}

function ownerResolution(atMs: number): LedgerEntry {
  const deviation = objectiveLandingFailedDeviation({
    rung: 'hosted-review',
    contentIdentity: CONTENT_IDENTITY,
    reason: 'hosted-review-state-moved'
  })
  return {
    kind: 'escalation',
    eventId: `owner-resolution-${atMs}`,
    watcherId: 'watcher-1',
    atMs,
    origin: 'owner',
    class: 'fact',
    escalationId: ownerDeviationEscalationId('watcher-1', deviation),
    escalationKind: 'owner-deviation',
    status: 'resolved',
    foldCount: 2
  }
}

describe('objective landing-stuck stop predicate', () => {
  it('fires once an indeterminate review has remained unresolved through the window', () => {
    const startedAtMs = 1_000
    const unresolved = attempt(REVIEW_ACTION, {
      state: 'settled',
      effect: 'indeterminate',
      reason: 'hosted-review-state-moved',
      atMs: startedAtMs
    })
    const history = ledger([unresolved])
    expect(
      objectiveLandingStuckPredicate.evaluate(
        snapshotAt(startedAtMs + OBJECTIVE_LANDING_STUCK_WINDOW_MS - 1),
        history
      )
    ).toEqual({ stop: false })

    const atWindow = snapshotAt(startedAtMs + OBJECTIVE_LANDING_STUCK_WINDOW_MS)
    const verdict = objectiveLandingStuckPredicate.evaluate(atWindow, history)
    expect(verdict).toEqual({
      stop: true,
      reason:
        'landing open-hosted-review indeterminate for 30 min (last: hosted-review-state-moved)',
      detail: CONTENT_IDENTITY
    })
    if (!verdict.stop) {
      throw new Error('expected a stuck landing verdict')
    }
    expect(objectiveLandingStuckPredicate.deviationForFiring?.(verdict, atWindow, history)).toEqual(
      {
        kind: 'landing-failed',
        rung: 'hosted-review',
        contentIdentity: CONTENT_IDENTITY,
        reason: 'hosted-review-state-moved'
      }
    )
  })

  it('ignores in-flight, landed, and stale-identity attempts', () => {
    const now = OBJECTIVE_LANDING_STUCK_WINDOW_MS + 10
    const inFlight = attempt(REVIEW_ACTION, { state: 'running', atMs: 1 })
    expect(objectiveLandingStuckPredicate.evaluate(snapshotAt(now), ledger([inFlight]))).toEqual({
      stop: false
    })

    const landed = attempt(REVIEW_ACTION, { state: 'settled', effect: 'landed', atMs: 1 })
    expect(objectiveLandingStuckPredicate.evaluate(snapshotAt(now), ledger([landed]))).toEqual({
      stop: false
    })

    const stale = attempt(
      { ...REVIEW_ACTION, contentIdentity: 'content-before' },
      { state: 'settled', effect: 'indeterminate', atMs: 1 }
    )
    expect(objectiveLandingStuckPredicate.evaluate(snapshotAt(now), ledger([stale]))).toEqual({
      stop: false
    })
  })

  it('parks a stuck commit attempt at its landing rung', () => {
    const startedAtMs = 10
    const failure = attempt(COMMIT_ACTION, {
      state: 'settled',
      effect: 'not-landed',
      reason: 'commit-result-unverifiable',
      atMs: startedAtMs
    })
    const atWindow = snapshotAt(startedAtMs + OBJECTIVE_LANDING_STUCK_WINDOW_MS)
    const history = ledger([failure])
    const verdict = objectiveLandingStuckPredicate.evaluate(atWindow, history)
    expect(verdict).toMatchObject({
      stop: true,
      reason: 'landing commit-local-branch not-landed for 30 min (last: commit-result-unverifiable)'
    })
    if (!verdict.stop) {
      throw new Error('expected the stuck commit verdict')
    }
    expect(
      objectiveLandingStuckPredicate.deviationForFiring?.(verdict, atWindow, history)
    ).toMatchObject({
      kind: 'landing-failed',
      rung: 'committed-local-branch',
      contentIdentity: CONTENT_IDENTITY,
      reason: 'commit-result-unverifiable'
    })
  })

  it('parks a stuck push attempt with an owner-routable landing deviation', () => {
    const startedAtMs = 10
    const failure = attempt(PUSH_ACTION, {
      state: 'settled',
      effect: 'not-landed',
      reason: 'remote-state-moved',
      atMs: startedAtMs
    })
    const atThirtyOneMinutes = snapshotAt(startedAtMs + OBJECTIVE_LANDING_STUCK_WINDOW_MS + 60_000)
    const history = ledger([failure])
    const verdict = objectiveLandingStuckPredicate.evaluate(atThirtyOneMinutes, history)
    expect(objectiveLandingStuckPredicate.disposition).toBe('park')
    expect(verdict).toEqual({
      stop: true,
      reason: 'landing push-ref not-landed for 31 min (last: remote-state-moved)',
      detail: CONTENT_IDENTITY
    })
    if (!verdict.stop) {
      throw new Error('expected the stuck push verdict')
    }
    expect(
      objectiveLandingStuckPredicate.deviationForFiring?.(verdict, atThirtyOneMinutes, history)
    ).toEqual({
      kind: 'landing-failed',
      rung: 'pushed-ref',
      contentIdentity: CONTENT_IDENTITY,
      reason: 'remote-state-moved'
    })
  })

  it('restarts the stuck window when an indeterminate attempt resolves not-landed', () => {
    const startedAtMs = 100
    const resolvedAtMs = startedAtMs + OBJECTIVE_LANDING_STUCK_WINDOW_MS - 60_000
    const unresolved = attempt(REVIEW_ACTION, {
      state: 'settled',
      effect: 'indeterminate',
      reason: 'hosted-review-state-moved',
      atMs: startedAtMs
    })
    const resolution: LedgerEntry = {
      kind: 'attempt-resolved',
      eventId: 'event-attempt-resolution',
      watcherId: 'watcher-1',
      atMs: resolvedAtMs,
      origin: 'owner',
      class: 'fact',
      attemptId: unresolved.attemptId,
      effect: 'not-landed',
      evidence: { status: 're-probe-absent' }
    }
    const history = ledger([unresolved, resolution])

    expect(
      objectiveLandingStuckPredicate.evaluate(
        snapshotAt(startedAtMs + OBJECTIVE_LANDING_STUCK_WINDOW_MS),
        history
      )
    ).toEqual({ stop: false })

    const afterResolutionWindow = snapshotAt(resolvedAtMs + OBJECTIVE_LANDING_STUCK_WINDOW_MS)
    const verdict = objectiveLandingStuckPredicate.evaluate(afterResolutionWindow, history)
    expect(verdict).toMatchObject({
      stop: true,
      reason: 'landing open-hosted-review not-landed for 30 min (last: attempt-resolved:not-landed)'
    })
    if (!verdict.stop) {
      throw new Error('expected a stuck landing after attempt resolution')
    }
    expect(
      objectiveLandingStuckPredicate.deviationForFiring?.(verdict, afterResolutionWindow, history)
    ).toMatchObject({
      kind: 'landing-failed',
      reason: 'attempt-resolved:not-landed'
    })
  })

  it('restarts the window at the owner’s latest resolution of the same deviation', () => {
    const startedAtMs = 100
    const resolvedAtMs = startedAtMs + 10 * 60_000
    const unresolved = attempt(REVIEW_ACTION, {
      state: 'settled',
      effect: 'indeterminate',
      reason: 'hosted-review-state-moved',
      atMs: startedAtMs
    })
    const history = ledger([unresolved, ownerResolution(resolvedAtMs)])
    expect(
      objectiveLandingStuckPredicate.evaluate(
        snapshotAt(resolvedAtMs + OBJECTIVE_LANDING_STUCK_WINDOW_MS - 1),
        history
      )
    ).toEqual({ stop: false })
    expect(
      objectiveLandingStuckPredicate.evaluate(
        snapshotAt(resolvedAtMs + OBJECTIVE_LANDING_STUCK_WINDOW_MS),
        history
      ).stop
    ).toBe(true)
  })

  it('keeps landing-bar completion ahead of landing-stuck parking', () => {
    const startedAtMs = 1
    const unresolved = attempt(REVIEW_ACTION, {
      state: 'settled',
      effect: 'indeterminate',
      atMs: startedAtMs
    })
    const reachedBar = projection({
      landing: [
        {
          rung: 'files-on-disk',
          revisionId: 'revision-1',
          contentIdentity: CONTENT_IDENTITY,
          atMs: 2
        }
      ]
    })
    const fired = evaluateStopPredicates(
      OBJECTIVE_STOP_PREDICATES,
      snapshotAt(startedAtMs + OBJECTIVE_LANDING_STUCK_WINDOW_MS, reachedBar),
      ledger([unresolved])
    )
    expect(OBJECTIVE_STOP_PREDICATES.indexOf(objectiveBarReachedPredicate)).toBeLessThan(
      OBJECTIVE_STOP_PREDICATES.indexOf(objectiveLandingStuckPredicate)
    )
    expect(fired).toMatchObject({
      predicateId: 'objective-bar-reached',
      disposition: 'terminal'
    })
  })
})
