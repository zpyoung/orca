import { describe, expect, it } from 'vitest'
import {
  objectiveReadOnlyWorkerInFlight,
  objectiveStaleEvidenceReissueEvidenceKey,
  OBJECTIVE_STALE_EVIDENCE_RETRY_CAP
} from './decide-stale-evidence'
import { attempt, ledger } from './decision-test-harness'
import type { ObjectiveAction } from './objective-actions'

const reviewDispatch: ObjectiveAction = {
  kind: 'dispatch-reviewer',
  capability: 'review',
  visibility: 'local',
  contentIdentity: 'content-current',
  evidenceKey: 'revision-1:plan-digest:review:content-current',
  revisionId: 'revision-1'
}

const runCheck: ObjectiveAction = {
  kind: 'run-check',
  capability: 'check',
  visibility: 'local',
  contentIdentity: 'content-current',
  evidenceKey: 'criterion-1:content-current',
  criterionId: 'criterion-1',
  command: 'pnpm check'
}

describe('objectiveReadOnlyWorkerInFlight', () => {
  it('is false with no matching attempts', () => {
    expect(objectiveReadOnlyWorkerInFlight([], ledger())).toBe(false)
  })

  it('is true while a reviewer/integrator/plan-review dispatch is running or indeterminate', () => {
    const running = [
      { attempt: attempt(reviewDispatch, { dispatchId: 'review-1' }), action: reviewDispatch }
    ]
    expect(objectiveReadOnlyWorkerInFlight(running, ledger())).toBe(true)

    const indeterminate = [
      {
        attempt: attempt(reviewDispatch, {
          dispatchId: 'review-1',
          state: 'settled',
          effect: 'indeterminate'
        }),
        action: reviewDispatch
      }
    ]
    expect(objectiveReadOnlyWorkerInFlight(indeterminate, ledger())).toBe(true)
  })

  it('is false once the worker settles landed or not-landed', () => {
    const landed = [
      {
        attempt: attempt(reviewDispatch, {
          dispatchId: 'review-1',
          state: 'settled',
          effect: 'landed'
        }),
        action: reviewDispatch
      }
    ]
    expect(objectiveReadOnlyWorkerInFlight(landed, ledger())).toBe(false)
  })
})

describe('objectiveStaleEvidenceReissueEvidenceKey', () => {
  const matches = (action: ObjectiveAction): boolean =>
    action.kind === 'run-check' &&
    action.criterionId === 'criterion-1' &&
    action.contentIdentity === 'content-current'

  it('ignores not-landed attempts with a different reason', () => {
    const attempts = [
      { attempt: attempt(runCheck, { state: 'settled', effect: 'not-landed' }), action: runCheck }
    ]
    expect(
      objectiveStaleEvidenceReissueEvidenceKey(
        'criterion-1:content-current',
        attempts,
        ledger(),
        matches
      )
    ).toBe('criterion-1:content-current#stale-0')
  })

  it('suffixes with the count of prior stale attempts at this identity', () => {
    const attempts = [
      {
        attempt: attempt(runCheck, {
          state: 'settled',
          effect: 'not-landed',
          reason: 'check-evidence-stale'
        }),
        action: runCheck
      }
    ]
    expect(
      objectiveStaleEvidenceReissueEvidenceKey(
        'criterion-1:content-current',
        attempts,
        ledger(),
        matches
      )
    ).toBe('criterion-1:content-current#stale-1')
  })

  it('returns null once prior stale attempts reach the cap', () => {
    const attempts = Array.from({ length: OBJECTIVE_STALE_EVIDENCE_RETRY_CAP }, (_, index) => ({
      attempt: attempt(runCheck, {
        state: 'settled',
        effect: 'not-landed',
        reason: 'check-evidence-stale',
        dispatchId: `stale-${index}`
      }),
      action: runCheck
    }))
    expect(
      objectiveStaleEvidenceReissueEvidenceKey(
        'criterion-1:content-current',
        attempts,
        ledger(),
        matches
      )
    ).toBeNull()
  })
})
