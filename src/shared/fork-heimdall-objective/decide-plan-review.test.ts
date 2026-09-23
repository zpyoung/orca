import { describe, expect, it } from 'vitest'
import {
  decideObjectivePlanReviewGate,
  type ObjectivePlanReviewGateTarget
} from './decide-plan-review'
import { decidePlannerAction, objectiveAttempts, projectObjectiveReports } from './decision-context'
import {
  attempt,
  capabilities,
  ledger,
  patch,
  planReview,
  projection,
  revision,
  snapshot,
  workerDone
} from './decision-test-harness'
import type { ActivatePlanAction, ApplyPlanPatchAction, ObjectiveAction } from './objective-actions'
import type { ObjectiveProjection, ObjectiveWorld } from './detail-types'
import type { WatcherLedger } from '../fork-heimdall/ledger-types'

const draftRevision = revision({
  id: 'revision-2',
  number: 2,
  status: 'draft',
  digest: 'draft-digest-2',
  createdByDispatchId: 'planner-dispatch-2',
  createdAtMs: 50,
  approvedAtMs: null
})

const activateAction: ActivatePlanAction = {
  kind: 'activate-plan',
  capability: 'plan',
  visibility: 'local',
  recovery: 'replay-safe',
  contentIdentity: 'content-current',
  evidenceKey: 'revision-2',
  revisionId: 'revision-2',
  digest: 'draft-digest-2'
}

const approvedRevision = revision()

const pendingPatch = patch({ status: 'pending' })

const applyAction: ApplyPlanPatchAction = {
  kind: 'apply-plan-patch',
  capability: 'plan',
  visibility: 'local',
  recovery: 'replay-safe',
  contentIdentity: 'content-current',
  evidenceKey: 'patch-1',
  revisionId: 'revision-1',
  patchId: 'patch-1',
  digest: 'patch-digest-1'
}

/** The `dispatch-planner` attempt whose report produced `draftRevision`, at a given `shape`. */
function draftCreatingAttempt(shape: 'full' | 'repair' | undefined) {
  const action: ObjectiveAction = {
    kind: 'dispatch-planner',
    capability: 'plan',
    visibility: 'local',
    contentIdentity: 'content-current',
    evidenceKey: 'plan:2',
    revisionNumber: 2,
    reason: 'initial',
    ...(shape === undefined ? {} : { shape })
  }
  return attempt(action, { dispatchId: 'planner-dispatch-2', state: 'settled', effect: 'landed' })
}

function decide(
  target: ObjectivePlanReviewGateTarget,
  action: ActivatePlanAction | ApplyPlanPatchAction,
  world: ObjectiveProjection,
  rawLedger: WatcherLedger = ledger(),
  worldOverrides: Partial<ObjectiveWorld> = {}
) {
  const snap = snapshot(world, worldOverrides)
  const attempts = objectiveAttempts(rawLedger)
  const reports = projectObjectiveReports(rawLedger)
  return decideObjectivePlanReviewGate(snap, rawLedger, attempts, reports, target, action)
}

describe('decideObjectivePlanReviewGate', () => {
  it('skips review for a draft when the review capability is off', () => {
    const world = projection({ revisions: [draftRevision] })
    const result = decide(
      { kind: 'revision', revision: draftRevision },
      activateAction,
      world,
      ledger([draftCreatingAttempt('full')]),
      { capabilities: capabilities({ review: 'off' }) }
    )
    expect(result).toEqual({ action: activateAction })
  })

  it('skips review for a patch when the review capability is off', () => {
    const world = { ...projection(), patches: [pendingPatch] }
    const result = decide(
      { kind: 'patch', patch: pendingPatch, revision: approvedRevision },
      applyAction,
      world,
      ledger(),
      { capabilities: capabilities({ review: 'off' }) }
    )
    expect(result).toEqual({ action: applyAction })
  })

  it('skips review for a draft from a pre-upgrade planner dispatch with no shape', () => {
    const world = projection({ revisions: [draftRevision] })
    const result = decide(
      { kind: 'revision', revision: draftRevision },
      activateAction,
      world,
      ledger([draftCreatingAttempt(undefined)])
    )
    expect(result).toEqual({ action: activateAction })
  })

  it("gates a draft created by decidePlannerAction's own initial dispatch", () => {
    const initialDispatch = decidePlannerAction(
      snapshot(projection({ revisions: [] })),
      ledger(),
      [],
      [],
      'initial',
      0
    )
    if (initialDispatch.action?.kind !== 'dispatch-planner') {
      throw new Error('Expected decidePlannerAction to emit a dispatch-planner action')
    }
    const plannerAttempt = attempt(initialDispatch.action, {
      dispatchId: 'planner-dispatch-new',
      state: 'settled',
      effect: 'landed'
    })
    const newDraft = revision({
      id: 'revision-new',
      number: initialDispatch.action.revisionNumber,
      status: 'draft',
      digest: 'draft-digest-new',
      createdByDispatchId: 'planner-dispatch-new',
      approvedAtMs: null
    })
    const newDraftActivateAction: ActivatePlanAction = {
      ...activateAction,
      evidenceKey: newDraft.id,
      revisionId: newDraft.id,
      digest: newDraft.digest
    }
    const result = decide(
      { kind: 'revision', revision: newDraft },
      newDraftActivateAction,
      projection({ revisions: [newDraft] }),
      ledger([plannerAttempt])
    )
    expect(result.action).toMatchObject({ kind: 'dispatch-plan-review' })
  })

  it('dispatches a plan review for a shape-bearing draft', () => {
    const world = projection({ revisions: [draftRevision] })
    const result = decide(
      { kind: 'revision', revision: draftRevision },
      activateAction,
      world,
      ledger([draftCreatingAttempt('full')])
    )
    expect(result.action).toMatchObject({
      kind: 'dispatch-plan-review',
      evidenceKey: 'plan-review:revision:revision-2:1',
      target: { kind: 'revision', revisionId: 'revision-2' },
      round: 1
    })
  })

  it('always reviews a pending patch, with no shape eligibility check', () => {
    const world = { ...projection(), patches: [pendingPatch] }
    const result = decide(
      { kind: 'patch', patch: pendingPatch, revision: approvedRevision },
      applyAction,
      world
    )
    expect(result.action).toMatchObject({
      kind: 'dispatch-plan-review',
      evidenceKey: 'plan-review:patch:patch-1:1',
      target: { kind: 'patch', patchId: 'patch-1' },
      round: 1
    })
  })

  it('activates a draft once its review approves', () => {
    const world = {
      ...projection({ revisions: [draftRevision] }),
      planReviews: [
        planReview({ targetKind: 'revision', targetId: 'revision-2', round: 1, verdict: 'approve' })
      ]
    }
    const result = decide(
      { kind: 'revision', revision: draftRevision },
      activateAction,
      world,
      ledger([draftCreatingAttempt('full')])
    )
    expect(result).toEqual({ action: activateAction })
  })

  it('applies a patch once its review approves', () => {
    const world = {
      ...projection(),
      patches: [pendingPatch],
      planReviews: [
        planReview({ targetKind: 'patch', targetId: 'patch-1', round: 1, verdict: 'approve' })
      ]
    }
    const result = decide(
      { kind: 'patch', patch: pendingPatch, revision: approvedRevision },
      applyAction,
      world
    )
    expect(result).toEqual({ action: applyAction })
  })

  it('redispatches the planner with a new revision number after a round-1 draft revise', () => {
    const world = {
      ...projection({ revisions: [draftRevision] }),
      planReviews: [
        planReview({ targetKind: 'revision', targetId: 'revision-2', round: 1, verdict: 'revise' })
      ]
    }
    const result = decide(
      { kind: 'revision', revision: draftRevision },
      activateAction,
      world,
      ledger([draftCreatingAttempt('full')])
    )
    expect(result.action).toMatchObject({
      kind: 'dispatch-planner',
      evidenceKey: 'plan:3',
      revisionNumber: 3,
      reason: 'replan-after-block'
    })
  })

  it('redispatches the repair planner at the next ordinal after a round-1 patch revise', () => {
    const revisedPatch = patch({ status: 'rejected', rejection: 'plan-review-revise' })
    const world = {
      ...projection(),
      patches: [revisedPatch],
      planReviews: [
        planReview({ targetKind: 'patch', targetId: 'patch-1', round: 1, verdict: 'revise' })
      ]
    }
    const result = decide(
      { kind: 'patch', patch: revisedPatch, revision: approvedRevision },
      applyAction,
      world
    )
    expect(result.action).toMatchObject({
      kind: 'dispatch-planner',
      evidenceKey: 'plan-repair:revision-1:2',
      shape: 'repair',
      repairRevisionId: 'revision-1',
      repairOrdinal: 2,
      reason: 'replan-after-block'
    })
  })

  it('requires approval instead of rejecting the target on a round-2 draft revise', () => {
    const priorRejectedDraft = revision({
      id: 'revision-2',
      number: 2,
      status: 'rejected',
      approvedAtMs: null,
      createdAtMs: 40
    })
    const secondDraft = revision({
      id: 'revision-3',
      number: 3,
      status: 'draft',
      digest: 'draft-digest-3',
      createdByDispatchId: 'planner-dispatch-3',
      createdAtMs: 60,
      approvedAtMs: null
    })
    const secondActivateAction: ActivatePlanAction = {
      ...activateAction,
      evidenceKey: 'revision-3',
      revisionId: 'revision-3',
      digest: 'draft-digest-3'
    }
    const world = {
      ...projection({ revisions: [priorRejectedDraft, secondDraft] }),
      planReviews: [
        planReview({
          targetKind: 'revision',
          targetId: 'revision-2',
          round: 1,
          dispatchId: 'review-1',
          verdict: 'revise'
        }),
        planReview({
          targetKind: 'revision',
          targetId: 'revision-3',
          round: 2,
          dispatchId: 'review-2',
          verdict: 'revise'
        })
      ]
    }
    const secondCreatingAttempt = attempt(
      {
        kind: 'dispatch-planner',
        capability: 'plan',
        visibility: 'local',
        contentIdentity: 'content-current',
        evidenceKey: 'plan:3',
        revisionNumber: 3,
        reason: 'replan-after-block',
        shape: 'full'
      },
      { dispatchId: 'planner-dispatch-3', state: 'settled', effect: 'landed' }
    )
    const result = decide(
      { kind: 'revision', revision: secondDraft },
      secondActivateAction,
      world,
      ledger([secondCreatingAttempt])
    )
    expect(result).toEqual({ action: { ...secondActivateAction, approvalRequired: true } })
  })

  it('requires approval instead of rejecting the target on an escalate verdict', () => {
    const world = {
      ...projection(),
      patches: [pendingPatch],
      planReviews: [
        planReview({ targetKind: 'patch', targetId: 'patch-1', round: 1, verdict: 'escalate' })
      ]
    }
    const result = decide(
      { kind: 'patch', patch: pendingPatch, revision: approvedRevision },
      applyAction,
      world
    )
    expect(result).toEqual({ action: { ...applyAction, approvalRequired: true } })
  })

  it('holds no-action while the review dispatch is in flight', () => {
    const world = { ...projection(), patches: [pendingPatch] }
    const inFlight = attempt(
      {
        kind: 'dispatch-plan-review',
        capability: 'review',
        visibility: 'local',
        contentIdentity: 'content-current',
        evidenceKey: 'plan-review:patch:patch-1:1',
        target: { kind: 'patch', patchId: 'patch-1' },
        round: 1
      },
      { dispatchId: 'review-dispatch-1', state: 'running' }
    )
    const result = decide(
      { kind: 'patch', patch: pendingPatch, revision: approvedRevision },
      applyAction,
      world,
      ledger([inFlight])
    )
    expect(result.action).toBeNull()
    expect(result).toMatchObject({ reason: 'plan-review-in-flight' })
  })

  it('ingests a landed review report that has not yet been ingested', () => {
    const world = { ...projection(), patches: [pendingPatch] }
    const reviewDispatch: ObjectiveAction = {
      kind: 'dispatch-plan-review',
      capability: 'review',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'plan-review:patch:patch-1:1',
      target: { kind: 'patch', patchId: 'patch-1' },
      round: 1
    }
    const result = decide(
      { kind: 'patch', patch: pendingPatch, revision: approvedRevision },
      applyAction,
      world,
      ledger([
        attempt(reviewDispatch, {
          dispatchId: 'review-dispatch-1',
          state: 'settled',
          effect: 'landed'
        }),
        workerDone('review-dispatch-1')
      ])
    )
    expect(result.action).toMatchObject({
      kind: 'ingest-plan-review',
      dispatchId: 'review-dispatch-1',
      target: { kind: 'patch', patchId: 'patch-1' }
    })
  })

  it('holds no-action while the review ingestion is in flight', () => {
    const world = { ...projection(), patches: [pendingPatch] }
    const reviewDispatch: ObjectiveAction = {
      kind: 'dispatch-plan-review',
      capability: 'review',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'plan-review:patch:patch-1:1',
      target: { kind: 'patch', patchId: 'patch-1' },
      round: 1
    }
    const ingestReview: ObjectiveAction = {
      kind: 'ingest-plan-review',
      capability: 'review',
      visibility: 'local',
      recovery: 'replay-safe',
      contentIdentity: 'content-current',
      evidenceKey: 'review-dispatch-1',
      dispatchId: 'review-dispatch-1',
      reportPath: '/outside/report.json',
      target: { kind: 'patch', patchId: 'patch-1' }
    }
    const result = decide(
      { kind: 'patch', patch: pendingPatch, revision: approvedRevision },
      applyAction,
      world,
      ledger([
        attempt(reviewDispatch, {
          dispatchId: 'review-dispatch-1',
          state: 'settled',
          effect: 'landed'
        }),
        workerDone('review-dispatch-1'),
        attempt(ingestReview, { dispatchId: 'ingest-review-1', state: 'running' })
      ])
    )
    expect(result.action).toBeNull()
    expect(result).toMatchObject({ reason: 'plan-review-in-flight' })
  })

  describe('a not-landed plan-review dispatch attempt (S2)', () => {
    function notLandedDispatch(evidenceKey: string, dispatchId: string) {
      const action: ObjectiveAction = {
        kind: 'dispatch-plan-review',
        capability: 'review',
        visibility: 'local',
        contentIdentity: 'content-current',
        evidenceKey,
        target: { kind: 'patch', patchId: 'patch-1' },
        round: 1
      }
      return attempt(action, { dispatchId, state: 'settled', effect: 'not-landed' })
    }

    it('retries once at a distinct evidence key instead of holding plan-review-in-flight forever', () => {
      const world = { ...projection(), patches: [pendingPatch] }
      const result = decide(
        { kind: 'patch', patch: pendingPatch, revision: approvedRevision },
        applyAction,
        world,
        ledger([notLandedDispatch('plan-review:patch:patch-1:1', 'review-dispatch-1')])
      )
      expect(result.action).toMatchObject({
        kind: 'dispatch-plan-review',
        evidenceKey: 'plan-review:patch:patch-1:1:retry-1',
        target: { kind: 'patch', patchId: 'patch-1' },
        round: 1
      })
    })

    it('holds no-action while the retry dispatch is in flight', () => {
      const world = { ...projection(), patches: [pendingPatch] }
      const retry = attempt(
        {
          kind: 'dispatch-plan-review',
          capability: 'review',
          visibility: 'local',
          contentIdentity: 'content-current',
          evidenceKey: 'plan-review:patch:patch-1:1:retry-1',
          target: { kind: 'patch', patchId: 'patch-1' },
          round: 1
        },
        { dispatchId: 'review-dispatch-2', state: 'running' }
      )
      const result = decide(
        { kind: 'patch', patch: pendingPatch, revision: approvedRevision },
        applyAction,
        world,
        ledger([notLandedDispatch('plan-review:patch:patch-1:1', 'review-dispatch-1'), retry])
      )
      expect(result.action).toBeNull()
      expect(result).toMatchObject({ reason: 'plan-review-in-flight' })
    })

    it('ingests a landed retry report, treating it as the same (target, round) as the original', () => {
      const world = { ...projection(), patches: [pendingPatch] }
      const retryDispatch: ObjectiveAction = {
        kind: 'dispatch-plan-review',
        capability: 'review',
        visibility: 'local',
        contentIdentity: 'content-current',
        evidenceKey: 'plan-review:patch:patch-1:1:retry-1',
        target: { kind: 'patch', patchId: 'patch-1' },
        round: 1
      }
      const result = decide(
        { kind: 'patch', patch: pendingPatch, revision: approvedRevision },
        applyAction,
        world,
        ledger([
          notLandedDispatch('plan-review:patch:patch-1:1', 'review-dispatch-1'),
          attempt(retryDispatch, {
            dispatchId: 'review-dispatch-2',
            state: 'settled',
            effect: 'landed'
          }),
          workerDone('review-dispatch-2')
        ])
      )
      expect(result.action).toMatchObject({
        kind: 'ingest-plan-review',
        dispatchId: 'review-dispatch-2',
        target: { kind: 'patch', patchId: 'patch-1' }
      })
    })

    it('applies the patch once the retry review is ingested and approves at the same round', () => {
      const world = {
        ...projection(),
        patches: [pendingPatch],
        planReviews: [
          planReview({
            targetKind: 'patch',
            targetId: 'patch-1',
            round: 1,
            dispatchId: 'review-dispatch-2',
            verdict: 'approve'
          })
        ]
      }
      const result = decide(
        { kind: 'patch', patch: pendingPatch, revision: approvedRevision },
        applyAction,
        world,
        ledger([notLandedDispatch('plan-review:patch:patch-1:1', 'review-dispatch-1')])
      )
      expect(result).toEqual({ action: applyAction })
    })

    it('requires approval instead of retrying again when the retry also settles not-landed', () => {
      const world = { ...projection(), patches: [pendingPatch] }
      const result = decide(
        { kind: 'patch', patch: pendingPatch, revision: approvedRevision },
        applyAction,
        world,
        ledger([
          notLandedDispatch('plan-review:patch:patch-1:1', 'review-dispatch-1'),
          notLandedDispatch('plan-review:patch:patch-1:1:retry-1', 'review-dispatch-2')
        ])
      )
      expect(result).toEqual({ action: { ...applyAction, approvalRequired: true } })
    })
  })
})
