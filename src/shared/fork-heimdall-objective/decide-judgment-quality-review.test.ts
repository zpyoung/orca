import { describe, expect, it } from 'vitest'
import type { AttemptEntry } from '../fork-heimdall/ledger-types'
import type { ObjectiveAttempt } from './decision-context'
import { decideBlockedReview } from './decide-judgment-quality-review'
import { attempt, ledger, node, projection, revision, snapshot } from './decision-test-harness'
import type { DispatchNodeAction } from './objective-actions'

function ownerRetryAction(taskKey: string): DispatchNodeAction {
  return {
    kind: 'dispatch-node',
    capability: 'implement',
    visibility: 'local',
    contentIdentity: 'content-current',
    evidenceKey: `revision-1:${taskKey}:owner-retry:content-current`,
    revisionId: 'revision-1',
    taskKey,
    depsOrchestrationIds: [],
    retryOf: `revision-1:${taskKey}`
  }
}

function ownerRetryAttempt(
  taskKey: string,
  state: AttemptEntry['state'],
  effect?: AttemptEntry['effect']
): ObjectiveAttempt {
  const action = ownerRetryAction(taskKey)
  return {
    attempt: attempt(action, {
      state,
      dispatchId: `owner-retry-${taskKey}`,
      ...(effect === undefined ? {} : { effect })
    }),
    action
  }
}

const world = snapshot(projection({ nodes: [node('core')] }))
const blockedRevision = revision()
const blocked = {
  status: 'blocked' as const,
  dispatchId: 'review-dispatch',
  summary: null
}

describe('decideBlockedReview, owner-retry suppression for a node-subject block', () => {
  it.each([
    ['in-flight (running)', 'running' as const, undefined],
    ['in-flight (attempted)', 'attempted' as const, undefined],
    ['indeterminate', 'settled' as const, 'indeterminate' as const]
  ])('withholds the deviation while the owner-retry dispatch is %s', (_label, state, effect) => {
    const decision = decideBlockedReview(
      world,
      ledger(),
      [ownerRetryAttempt('core', state, effect)],
      [],
      blockedRevision,
      'reviewer',
      blocked,
      true,
      { taskKey: 'core' }
    )

    expect(decision).toEqual({
      action: null,
      reason: 'node-in-flight',
      detail: 'core',
      considered: [{ phase: 'implementation', reason: 'node-in-flight', detail: 'core' }]
    })
  })

  it.each([
    ['landed', 'landed' as const],
    ['not-landed', 'not-landed' as const]
  ])(
    'resumes normal blocked-review handling once the owner-retry dispatch is %s',
    (_label, effect) => {
      const decision = decideBlockedReview(
        world,
        ledger(),
        [ownerRetryAttempt('core', 'settled', effect)],
        [],
        blockedRevision,
        'reviewer',
        blocked,
        true,
        { taskKey: 'core' }
      )

      expect(decision).toMatchObject({
        action: null,
        deviation: { kind: 'review-blocked', role: 'reviewer', dispatchId: 'review-dispatch' }
      })
    }
  )

  it('raises the deviation as before when no owner retry is in flight for the task', () => {
    const decision = decideBlockedReview(
      world,
      ledger(),
      [],
      [],
      blockedRevision,
      'reviewer',
      blocked,
      true,
      { taskKey: 'core' }
    )

    expect(decision).toMatchObject({
      action: null,
      deviation: { kind: 'review-blocked', role: 'reviewer', dispatchId: 'review-dispatch' }
    })
  })

  it('raises the deviation when the blocked subject has no owner-retryable task', () => {
    const decision = decideBlockedReview(
      world,
      ledger(),
      [ownerRetryAttempt('core', 'running')],
      [],
      blockedRevision,
      'reviewer',
      blocked,
      true,
      undefined
    )

    expect(decision).toMatchObject({
      action: null,
      deviation: { kind: 'review-blocked', role: 'reviewer', dispatchId: 'review-dispatch' }
    })
  })

  it('ignores an in-flight owner-retry dispatch for a different task', () => {
    const decision = decideBlockedReview(
      world,
      ledger(),
      [ownerRetryAttempt('core', 'running')],
      [],
      blockedRevision,
      'reviewer',
      blocked,
      true,
      { taskKey: 'other-task' }
    )

    expect(decision).toMatchObject({
      action: null,
      deviation: { kind: 'review-blocked', role: 'reviewer', dispatchId: 'review-dispatch' }
    })
  })
})

describe('decideBlockedReview, owner-retry suppression for a revision-level block', () => {
  it('withholds the deviation while an owner retry of any task in the revision is in flight', () => {
    const decision = decideBlockedReview(
      world,
      ledger(),
      [ownerRetryAttempt('ultracode-report-reconcile', 'running')],
      [],
      blockedRevision,
      'reviewer',
      blocked,
      true,
      { anyTaskInRevision: true }
    )

    expect(decision).toMatchObject({
      action: null,
      reason: 'node-in-flight',
      detail: 'ultracode-report-reconcile'
    })
    expect('deviation' in decision).toBe(false)
  })

  it('resumes normal blocked-review handling once that owner retry settles', () => {
    const decision = decideBlockedReview(
      world,
      ledger(),
      [ownerRetryAttempt('ultracode-report-reconcile', 'settled', 'landed')],
      [],
      blockedRevision,
      'reviewer',
      blocked,
      true,
      { anyTaskInRevision: true }
    )

    expect(decision).toMatchObject({
      action: null,
      deviation: { kind: 'review-blocked', role: 'reviewer', dispatchId: 'review-dispatch' }
    })
  })

  it('raises the deviation for a revision-level block when no owner retry is in flight', () => {
    const decision = decideBlockedReview(
      world,
      ledger(),
      [],
      [],
      blockedRevision,
      'integrator',
      blocked,
      true,
      { anyTaskInRevision: true }
    )

    expect(decision).toMatchObject({
      action: null,
      deviation: { kind: 'review-blocked', role: 'integrator', dispatchId: 'review-dispatch' }
    })
  })

  it('ignores an owner retry of a task in a different revision', () => {
    const otherRevisionRetry: DispatchNodeAction = {
      ...ownerRetryAction('ultracode-report-reconcile'),
      revisionId: 'revision-2',
      evidenceKey: 'revision-2:ultracode-report-reconcile:owner-retry:content-current'
    }
    const decision = decideBlockedReview(
      world,
      ledger(),
      [
        {
          attempt: attempt(otherRevisionRetry, {
            state: 'running',
            dispatchId: 'owner-retry-other-revision'
          }),
          action: otherRevisionRetry
        }
      ],
      [],
      blockedRevision,
      'reviewer',
      blocked,
      true,
      { anyTaskInRevision: true }
    )

    expect(decision).toMatchObject({
      action: null,
      deviation: { kind: 'review-blocked', role: 'reviewer', dispatchId: 'review-dispatch' }
    })
  })
})
