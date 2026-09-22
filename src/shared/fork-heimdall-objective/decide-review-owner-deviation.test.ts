import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createReportValidationProvenance } from '../fork-heimdall/effect-certainty'

const judgmentQualityReviewSubjectsMock = vi.hoisted(() => vi.fn((): string[] => []))

vi.mock('../fork-heimdall/judgment/objective-judgment-policy', () => ({
  judgmentQualityReviewSubjects: judgmentQualityReviewSubjectsMock
}))

import { decideObjective } from './decision'
import {
  attempt,
  CONTRACT,
  ledger,
  node,
  projection,
  snapshot,
  workerDone
} from './decision-test-harness'
import type { ObjectiveAction } from './objective-actions'
import type { ObjectiveVerdictProjection, ObjectiveWorld } from './detail-types'

beforeEach(() => {
  judgmentQualityReviewSubjectsMock.mockReset()
  judgmentQualityReviewSubjectsMock.mockReturnValue([])
})

describe('objective check deviations, owner configured', () => {
  const checked = node('core', {
    state: 'succeeded',
    criteria: [
      {
        id: 'criterion-1',
        ordinal: 0,
        body: 'The focused check passes.',
        shellCheckable: true,
        checkCommand: 'pnpm check',
        lastCheck: { contentIdentity: 'content-current', exitCode: 1, timedOut: false, atMs: 50 },
        lastReview: null
      }
    ]
  })

  it('emits check-failed instead of replanning when the last check result failed', () => {
    const decision = decideObjective(snapshot(projection({ nodes: [checked] })), ledger(), true)
    expect(decision.action).toBeNull()
    expect(decision).toMatchObject({
      deviation: {
        kind: 'check-failed',
        criterionId: 'criterion-1',
        command: 'pnpm check',
        exitCode: 1,
        timedOut: false
      }
    })
  })

  it('still replans automatically for the same check failure when no owner is configured', () => {
    const decision = decideObjective(snapshot(projection({ nodes: [checked] })), ledger())
    expect(decision.action).toMatchObject({
      kind: 'dispatch-planner',
      reason: 'replan-after-failure'
    })
    expect('deviation' in decision).toBe(false)
  })
})

describe('objective review deviations, owner configured', () => {
  const blocked = projection({
    nodes: [node('core', { state: 'succeeded' })],
    verdicts: [
      {
        dispatchId: 'review-dispatch',
        revisionId: 'revision-1',
        role: 'reviewer',
        verdict: 'block',
        contentIdentity: 'content-current',
        reportDigest: 'review-digest',
        atMs: 50
      }
    ]
  })

  it('emits review-blocked with the blocking dispatch instead of replanning', () => {
    const decision = decideObjective(snapshot(blocked), ledger(), true)
    expect(decision.action).toBeNull()
    expect(decision).toMatchObject({
      deviation: { kind: 'review-blocked', role: 'reviewer', dispatchId: 'review-dispatch' }
    })
  })

  it('still replans automatically for the same blocked review when no owner is configured', () => {
    const decision = decideObjective(snapshot(blocked), ledger())
    expect(decision.action).toMatchObject({
      kind: 'dispatch-planner',
      reason: 'replan-after-block'
    })
    expect('deviation' in decision).toBe(false)
  })
})

describe('objective report provenance deviations', () => {
  it.each([
    { role: 'reviewer' as const, tier: 'standard' as const, code: 'missing' as const },
    { role: 'integrator' as const, tier: 'full' as const, code: 'malformed' as const }
  ])('retains $code $role report provenance in the owner deviation', ({ role, tier, code }) => {
    const dispatchId = `${role}-dispatch`
    const reportPath = `/outside/${role}.json`
    const dispatchAction: ObjectiveAction =
      role === 'reviewer'
        ? {
            kind: 'dispatch-reviewer',
            capability: 'review',
            visibility: 'local',
            contentIdentity: 'content-current',
            evidenceKey: 'revision-1:plan-digest:review:content-current',
            revisionId: 'revision-1'
          }
        : {
            kind: 'dispatch-integrator',
            capability: 'review',
            visibility: 'local',
            contentIdentity: 'content-current',
            evidenceKey: 'revision-1:plan-digest:review:content-current',
            revisionId: 'revision-1'
          }
    const ingestAction: ObjectiveAction = {
      kind: 'ingest-verdict',
      capability: 'review',
      visibility: 'local',
      recovery: 'replay-safe',
      contentIdentity: 'content-current',
      evidenceKey: `revision-1:plan-digest:${role}:ingest:${dispatchId}:content-current`,
      revisionId: 'revision-1',
      role,
      dispatchId,
      reportPath,
      reviewedContentIdentity: 'content-current'
    }
    const detail = `${role} report ${code} at authoritative path`
    const failedIngestion = {
      ...attempt(ingestAction, {
        state: 'settled',
        effect: 'not-landed',
        dispatchId: `${dispatchId}-ingest`,
        reason: `review-report-${code}`
      }),
      result: {
        reportValidation: createReportValidationProvenance({
          status: 'rejected',
          code,
          role,
          dispatchId,
          reportPath,
          detail,
          hostVerifiable: true
        })
      }
    }
    const verdicts = role === 'integrator' ? [reviewerApproval] : []
    const decision = decideObjective(
      snapshot(
        projection({
          nodes: [node('core', { state: 'succeeded' })],
          verdicts
        }),
        { contract: { ...CONTRACT, tier } }
      ),
      ledger([
        attempt(dispatchAction, {
          state: 'settled',
          effect: 'landed',
          dispatchId
        }),
        workerDone(dispatchId, reportPath),
        failedIngestion
      ]),
      true
    )

    expect(decision).toMatchObject({
      action: null,
      deviation: {
        kind: 'review-blocked',
        role,
        dispatchId,
        detail: expect.stringContaining(detail)
      }
    })
  })
})

const sourceDispatch: ObjectiveAction = {
  kind: 'dispatch-node',
  capability: 'implement',
  visibility: 'local',
  contentIdentity: 'content-current',
  evidenceKey: 'revision-1:core:content-current',
  revisionId: 'revision-1',
  taskKey: 'core',
  depsOrchestrationIds: []
}

const judgmentReviewDispatch: ObjectiveAction = {
  kind: 'dispatch-reviewer',
  capability: 'review',
  visibility: 'local',
  contentIdentity: 'content-current',
  evidenceKey:
    'revision-1:plan-digest:revision-1:core:content-current:judgment-review:content-current',
  revisionId: 'revision-1',
  judgmentReviewOf: 'source-dispatch'
}

const judgmentBlock: ObjectiveVerdictProjection = {
  dispatchId: 'judgment-review-dispatch',
  revisionId: 'revision-1',
  role: 'reviewer',
  verdict: 'block',
  contentIdentity: 'content-current',
  reportDigest: 'judgment-block-digest',
  atMs: 50
}

const reviewerApproval: ObjectiveVerdictProjection = {
  dispatchId: 'later-reviewer-approval',
  revisionId: 'revision-1',
  role: 'reviewer',
  verdict: 'approve',
  contentIdentity: 'content-current',
  reportDigest: 'reviewer-approval-digest',
  atMs: 60
}

const integratorApproval: ObjectiveVerdictProjection = {
  dispatchId: 'integrator-approval',
  revisionId: 'revision-1',
  role: 'integrator',
  verdict: 'approve',
  contentIdentity: 'content-current',
  reportDigest: 'integrator-approval-digest',
  atMs: 70
}

function decideJudgmentReview(
  tier: ObjectiveWorld['contract']['tier'],
  verdicts: readonly ObjectiveVerdictProjection[],
  ownerConfigured: boolean
) {
  judgmentQualityReviewSubjectsMock.mockReturnValue(['source-dispatch'])
  return decideObjective(
    snapshot(
      projection({
        nodes: [node('core', { state: 'succeeded' })],
        verdicts: [...verdicts]
      }),
      { contract: { ...CONTRACT, tier } }
    ),
    ledger([
      attempt(sourceDispatch, {
        state: 'settled',
        effect: 'landed',
        dispatchId: 'source-dispatch'
      }),
      attempt(judgmentReviewDispatch, {
        state: 'settled',
        effect: 'landed',
        dispatchId: 'judgment-review-dispatch'
      })
    ]),
    ownerConfigured
  )
}

describe('judgment quality review deviations', () => {
  it.each([
    ['express', []],
    ['standard', [reviewerApproval]],
    ['full', [reviewerApproval, integratorApproval]]
  ] as const)('routes a blocked %s-tier judgment review to the owner', (tier, approvals) => {
    const decision = decideJudgmentReview(tier, [judgmentBlock, ...approvals], true)

    expect(decision).toEqual({
      action: null,
      deviation: {
        kind: 'review-blocked',
        role: 'reviewer',
        dispatchId: 'judgment-review-dispatch',
        summary: null
      }
    })
  })

  it('still replans automatically for a judgment review block without an owner', () => {
    const decision = decideJudgmentReview('express', [judgmentBlock], false)

    expect(decision.action).toMatchObject({
      kind: 'dispatch-planner',
      reason: 'replan-after-block'
    })
    expect('deviation' in decision).toBe(false)
  })

  it('accepts an owner-synthesized approval for the same revision and reviewer stage', () => {
    const ownerApproval: ObjectiveVerdictProjection = {
      ...reviewerApproval,
      dispatchId: 'owner-skip-review:revision-1:reviewer:content-current',
      synthesizedByOwner: true
    }
    const decision = decideJudgmentReview('standard', [judgmentBlock, ownerApproval], true)

    expect(decision.action).toMatchObject({
      kind: 'record-landing',
      revisionId: 'revision-1'
    })
    expect('deviation' in decision).toBe(false)
  })

  it('does not clear the block with a real approval or owner approvals for another revision or role', () => {
    const decision = decideJudgmentReview(
      'express',
      [
        judgmentBlock,
        reviewerApproval,
        {
          ...reviewerApproval,
          dispatchId: 'owner-skip-review:revision-2:reviewer:content-current',
          revisionId: 'revision-2',
          synthesizedByOwner: true
        },
        {
          ...integratorApproval,
          dispatchId: 'owner-skip-review:revision-1:integrator:content-current',
          synthesizedByOwner: true
        }
      ],
      true
    )

    expect(decision).toMatchObject({
      action: null,
      deviation: {
        kind: 'review-blocked',
        dispatchId: 'judgment-review-dispatch'
      }
    })
  })
})
