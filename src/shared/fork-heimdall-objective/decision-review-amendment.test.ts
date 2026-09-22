import { describe, expect, it } from 'vitest'
import { decideObjective } from './decision'
import {
  attempt,
  CONTRACT,
  ledger,
  node,
  projection,
  revision,
  snapshot,
  workerDone
} from './decision-test-harness'
import type { ObjectiveAction } from './objective-actions'
import type { ObjectiveReviewRole } from './detail-types'

const amendedRevision = revision({
  digest: 'amendment-digest',
  amendments: [
    {
      ordinal: 1,
      digest: 'amendment-digest',
      amendedAtMs: 60,
      attestation: 'Acceptance criteria changed without changing the worktree',
      touchedTaskKeys: ['core']
    }
  ]
})

const amendedNode = node('core', {
  state: 'succeeded',
  criteria: [
    {
      id: 'criterion-amended',
      ordinal: 0,
      body: 'The amended behavior is covered',
      shellCheckable: false,
      checkCommand: null,
      lastCheck: null,
      lastReview: null
    }
  ]
})

function completedPreAmendmentReview(role: ObjectiveReviewRole) {
  const dispatchId = `old-${role}-dispatch`
  const dispatch: ObjectiveAction =
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
  const ingestion: ObjectiveAction = {
    kind: 'ingest-verdict',
    capability: 'review',
    visibility: 'local',
    recovery: 'replay-safe',
    contentIdentity: 'content-current',
    evidenceKey: `revision-1:plan-digest:${role}:ingest:${dispatchId}:content-current`,
    revisionId: 'revision-1',
    role,
    dispatchId,
    reportPath: `/reports/${role}.json`,
    reviewedContentIdentity: 'content-current'
  }
  return [
    attempt(dispatch, { state: 'settled', effect: 'landed', dispatchId }),
    workerDone(dispatchId, `/reports/${role}.json`),
    attempt(ingestion, {
      state: 'settled',
      effect: 'landed',
      dispatchId: `${dispatchId}-ingestion`
    })
  ]
}

describe('review identity after same-tree plan amendments', () => {
  it('dispatches a fresh reviewer for amended criteria instead of reusing the old completed review', () => {
    const plan = projection({ revisions: [amendedRevision], nodes: [amendedNode] })
    const decision = decideObjective(
      snapshot(plan),
      ledger(completedPreAmendmentReview('reviewer'))
    )
    expect(decision.action).toMatchObject({
      kind: 'dispatch-reviewer',
      contentIdentity: 'content-current',
      evidenceKey: 'revision-1:amendment-digest:review:content-current'
    })
  })

  it('dispatches a fresh integrator after the amended plan receives its new reviewer approval', () => {
    const plan = projection({
      revisions: [amendedRevision],
      nodes: [amendedNode],
      verdicts: [
        {
          dispatchId: 'new-reviewer-dispatch',
          revisionId: 'revision-1',
          role: 'reviewer',
          verdict: 'approve',
          contentIdentity: 'content-current',
          reportDigest: 'new-reviewer-digest',
          atMs: 70
        }
      ]
    })
    const decision = decideObjective(
      snapshot(plan, { contract: { ...CONTRACT, tier: 'full' } }),
      ledger(completedPreAmendmentReview('integrator'))
    )
    expect(decision.action).toMatchObject({
      kind: 'dispatch-integrator',
      contentIdentity: 'content-current',
      evidenceKey: 'revision-1:amendment-digest:review:content-current'
    })
  })
})
