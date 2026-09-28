import { describe, expect, it } from 'vitest'
import { decideObjective } from './decision'
import { attempt, CONTRACT, ledger, projection, snapshot } from './decision-test-harness'

const reviewSnapshot = snapshot(
  projection({
    landing: [
      {
        rung: 'pushed-ref',
        revisionId: 'revision-1',
        contentIdentity: 'content-current',
        branch: 'feature/objective',
        commitSha: 'commit-1',
        atMs: 70
      }
    ]
  }),
  { contract: { ...CONTRACT, landingBar: 'merged' } },
  'content-current'
)

describe('hosted-review landing retries', () => {
  it('uses two distinct retry keys after the original attempt, then exhausts', () => {
    const first = decideObjective(reviewSnapshot, ledger()).action
    expect(first).toMatchObject({
      kind: 'open-hosted-review',
      evidenceKey: 'hosted-review:github:feature/objective:commit-1'
    })
    if (first === null) {
      throw new Error('expected the initial hosted-review action')
    }

    const originalFailure = attempt(first, {
      state: 'settled',
      effect: 'not-landed',
      atMs: 80
    })
    const second = decideObjective(reviewSnapshot, ledger([originalFailure])).action
    expect(second).toMatchObject({
      kind: 'open-hosted-review',
      evidenceKey: 'hosted-review:github:feature/objective:commit-1:retry-1'
    })
    if (second === null) {
      throw new Error('expected the first hosted-review retry')
    }

    const firstRetryFailure = attempt(second, {
      state: 'settled',
      effect: 'not-landed',
      atMs: 90
    })
    const third = decideObjective(
      reviewSnapshot,
      ledger([originalFailure, firstRetryFailure])
    ).action
    expect(third).toMatchObject({
      kind: 'open-hosted-review',
      evidenceKey: 'hosted-review:github:feature/objective:commit-1:retry-2'
    })
    if (third === null) {
      throw new Error('expected the second hosted-review retry')
    }

    const secondRetryFailure = attempt(third, {
      state: 'settled',
      effect: 'not-landed',
      atMs: 100
    })
    const exhausted = decideObjective(
      reviewSnapshot,
      ledger([originalFailure, firstRetryFailure, secondRetryFailure])
    )
    expect(exhausted.action).toBeNull()
    expect(exhausted).toMatchObject({ reason: 'landing-retry-exhausted' })
  })

  it('keeps an indeterminate retry in flight instead of consuming another retry key', () => {
    const first = decideObjective(reviewSnapshot, ledger()).action
    if (first === null) {
      throw new Error('expected the initial hosted-review action')
    }
    const originalFailure = attempt(first, {
      state: 'settled',
      effect: 'not-landed',
      atMs: 80
    })
    const retry = decideObjective(reviewSnapshot, ledger([originalFailure])).action
    if (retry === null) {
      throw new Error('expected the first hosted-review retry')
    }
    const unresolved = attempt(retry, {
      state: 'settled',
      effect: 'indeterminate',
      reason: 'hosted-review-state-moved',
      atMs: 90
    })

    expect(decideObjective(reviewSnapshot, ledger([originalFailure, unresolved]))).toMatchObject({
      action: null,
      reason: 'landing-in-flight'
    })
  })

  it('does not count a not-landed attempt from a stale content identity', () => {
    const first = decideObjective(reviewSnapshot, ledger()).action
    if (first === null) {
      throw new Error('expected the initial hosted-review action')
    }
    const staleFailure = attempt(
      { ...first, contentIdentity: 'content-before' },
      { state: 'settled', effect: 'not-landed', atMs: 80 }
    )
    expect(decideObjective(reviewSnapshot, ledger([staleFailure])).action).toMatchObject({
      kind: 'open-hosted-review',
      contentIdentity: 'content-current',
      evidenceKey: first.evidenceKey
    })
  })
})
