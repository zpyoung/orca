import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PlanReviewReport } from '../../shared/fork-heimdall-objective/plan-review-schema'
import type { PlannerReport } from '../../shared/fork-heimdall-objective/plan-schema'
import { ObjectiveDatabase } from './objective-database'
import { ObjectiveStore } from './objective-store'
import { projectPlanReviews } from './objective-store-plan-reviews'

const WATCHER_ID = 'watcher-plan-reviews-1'
const APPROVE_REPORT: PlanReviewReport = {
  verdict: 'approve',
  assumptions: [],
  findings: [],
  summary: 'Looks solid'
}
const REVISE_REPORT: PlanReviewReport = {
  verdict: 'revise',
  assumptions: [],
  findings: [{ taskKey: 'task-a', severity: 'blocking', body: 'Missing coverage' }],
  summary: 'Needs another pass'
}
const PLAN_REPORT: PlannerReport = {
  plan: [
    {
      taskKey: 'task-a',
      title: 'Task A',
      spec: 'Implement A',
      deps: [],
      criteria: [{ body: 'A works', shellCheckable: false, checkCommand: null }],
      declaresDependencyChange: false
    }
  ]
}

let database: ObjectiveDatabase
let store: ObjectiveStore
const opened: ObjectiveDatabase[] = []

beforeEach(() => {
  database = new ObjectiveDatabase(':memory:')
  opened.push(database)
  store = new ObjectiveStore(database, () => 9_999)
})

afterEach(() => {
  for (const item of opened) {
    item.close()
  }
  opened.length = 0
})

describe('ObjectiveStore plan reviews', () => {
  it('records a review and replays the same dispatch unchanged', () => {
    const args = {
      watcherId: WATCHER_ID,
      targetKind: 'revision' as const,
      targetId: 'revision-1',
      round: 1 as const,
      dispatchId: 'plan-review-1',
      report: APPROVE_REPORT,
      reportDigest: 'digest-1',
      createdAtMs: 500
    }

    const record = store.recordPlanReviewAndRejectRoundOneTarget(args)
    expect(record.report).toEqual(APPROVE_REPORT)
    expect(store.recordPlanReviewAndRejectRoundOneTarget(args)).toEqual(record)
    expect(store.getPlanReviewReport(record.id)).toEqual(APPROVE_REPORT)
    expect(store.getPlanReviewReport('missing-id')).toBeNull()
  })

  it('refuses a second dispatch for the same target and round', () => {
    store.recordPlanReviewAndRejectRoundOneTarget({
      watcherId: WATCHER_ID,
      targetKind: 'revision',
      targetId: 'revision-1',
      round: 1,
      dispatchId: 'plan-review-1',
      report: APPROVE_REPORT,
      reportDigest: 'digest-1',
      createdAtMs: 500
    })

    expect(() =>
      store.recordPlanReviewAndRejectRoundOneTarget({
        watcherId: WATCHER_ID,
        targetKind: 'revision',
        targetId: 'revision-1',
        round: 1,
        dispatchId: 'plan-review-2',
        report: REVISE_REPORT,
        reportDigest: 'digest-2',
        createdAtMs: 501
      })
    ).toThrow(/already recorded by a different dispatch/)
  })

  it('refuses replaying a dispatch with different content', () => {
    store.recordPlanReviewAndRejectRoundOneTarget({
      watcherId: WATCHER_ID,
      targetKind: 'revision',
      targetId: 'revision-1',
      round: 1,
      dispatchId: 'plan-review-1',
      report: APPROVE_REPORT,
      reportDigest: 'digest-1',
      createdAtMs: 500
    })

    expect(() =>
      store.recordPlanReviewAndRejectRoundOneTarget({
        watcherId: WATCHER_ID,
        targetKind: 'revision',
        targetId: 'revision-1',
        round: 1,
        dispatchId: 'plan-review-1',
        report: REVISE_REPORT,
        reportDigest: 'digest-2',
        createdAtMs: 500
      })
    ).toThrow(/different content/)
  })

  it('permits a second round for the same target, and lists reviews newest first', () => {
    const first = store.recordPlanReviewAndRejectRoundOneTarget({
      watcherId: WATCHER_ID,
      targetKind: 'patch',
      targetId: 'patch-1',
      round: 1,
      dispatchId: 'plan-review-round-1',
      report: APPROVE_REPORT,
      reportDigest: 'digest-1',
      createdAtMs: 500
    })
    const second = store.recordPlanReviewAndRejectRoundOneTarget({
      watcherId: WATCHER_ID,
      targetKind: 'patch',
      targetId: 'patch-1',
      round: 2,
      dispatchId: 'plan-review-round-2',
      report: APPROVE_REPORT,
      reportDigest: 'digest-2',
      createdAtMs: 600
    })

    expect(store.listPlanReviews(WATCHER_ID)).toEqual([second, first])
  })

  it('caps the projection at the newest 1,024 reviews out of 1,025 stored', () => {
    for (let i = 0; i < 1_025; i++) {
      store.recordPlanReviewAndRejectRoundOneTarget({
        watcherId: WATCHER_ID,
        targetKind: 'patch',
        targetId: `patch-${i}`,
        round: 1,
        dispatchId: `plan-review-${i}`,
        report: APPROVE_REPORT,
        reportDigest: `digest-${i}`,
        createdAtMs: 1_000 + i
      })
    }

    const projected = projectPlanReviews(database.connection(), WATCHER_ID)
    expect(projected).toHaveLength(1_024)
    expect(projected[0]?.dispatchId).toBe('plan-review-1024')
    expect(projected.at(-1)?.dispatchId).toBe('plan-review-1')
    expect(projected.some((review) => review.dispatchId === 'plan-review-0')).toBe(false)
  })
})

describe('recordPlanReviewAndRejectRoundOneTarget', () => {
  it('records the review and rejects the draft revision in one call', () => {
    const draft = store.ingestPlan({
      watcherId: WATCHER_ID,
      revisionNumber: 1,
      dispatchId: 'planner-1',
      report: PLAN_REPORT,
      digest: 'plan-digest-1',
      createdAtMs: 100
    })

    const record = store.recordPlanReviewAndRejectRoundOneTarget({
      watcherId: WATCHER_ID,
      targetKind: 'revision',
      targetId: draft.revisionId,
      round: 1,
      dispatchId: 'plan-review-1',
      report: REVISE_REPORT,
      reportDigest: 'digest-1',
      createdAtMs: 500
    })

    expect(record.report).toEqual(REVISE_REPORT)
    expect(store.project(WATCHER_ID).revisions[0]?.status).toBe('rejected')
  })

  it('records the review and rejects the pending patch in one call', () => {
    const revision = store.ingestPlan({
      watcherId: WATCHER_ID,
      revisionNumber: 1,
      dispatchId: 'planner-1',
      report: PLAN_REPORT,
      digest: 'plan-digest-1',
      createdAtMs: 100
    })
    store.activatePlan({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      digest: revision.digest,
      approvedAtMs: 200
    })
    const patch = store.ingestPlanPatch({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      dispatchId: 'repair-1',
      repairOrdinal: 0,
      report: { repair: { upsertTasks: [], dropTaskKeys: ['task-a'] }, assumptions: [] },
      createdAtMs: 300
    })

    store.recordPlanReviewAndRejectRoundOneTarget({
      watcherId: WATCHER_ID,
      targetKind: 'patch',
      targetId: patch.id,
      round: 1,
      dispatchId: 'plan-review-1',
      report: REVISE_REPORT,
      reportDigest: 'digest-1',
      createdAtMs: 500
    })

    expect(store.getPlanPatch(patch.id)).toMatchObject({
      status: 'rejected',
      rejection: 'plan-review-revise'
    })
  })

  it('does not reject the target for an approve verdict or a round-two revise', () => {
    const draft = store.ingestPlan({
      watcherId: WATCHER_ID,
      revisionNumber: 1,
      dispatchId: 'planner-1',
      report: PLAN_REPORT,
      digest: 'plan-digest-1',
      createdAtMs: 100
    })

    store.recordPlanReviewAndRejectRoundOneTarget({
      watcherId: WATCHER_ID,
      targetKind: 'revision',
      targetId: draft.revisionId,
      round: 1,
      dispatchId: 'plan-review-approve',
      report: APPROVE_REPORT,
      reportDigest: 'digest-1',
      createdAtMs: 500
    })
    expect(store.project(WATCHER_ID).revisions[0]?.status).toBe('draft')

    store.recordPlanReviewAndRejectRoundOneTarget({
      watcherId: WATCHER_ID,
      targetKind: 'revision',
      targetId: draft.revisionId,
      round: 2,
      dispatchId: 'plan-review-round-2',
      report: REVISE_REPORT,
      reportDigest: 'digest-2',
      createdAtMs: 600
    })
    expect(store.project(WATCHER_ID).revisions[0]?.status).toBe('draft')
  })

  it('leaves no review row when the round-one rejection write fails', () => {
    const revision = store.ingestPlan({
      watcherId: WATCHER_ID,
      revisionNumber: 1,
      dispatchId: 'planner-1',
      report: PLAN_REPORT,
      digest: 'plan-digest-1',
      createdAtMs: 100
    })
    // an already-approved revision can no longer be rejected as a draft, so its round-one
    // rejection write fails after the review row would otherwise have been inserted
    store.activatePlan({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      digest: revision.digest,
      approvedAtMs: 200
    })

    expect(() =>
      store.recordPlanReviewAndRejectRoundOneTarget({
        watcherId: WATCHER_ID,
        targetKind: 'revision',
        targetId: revision.revisionId,
        round: 1,
        dispatchId: 'plan-review-atomic',
        report: REVISE_REPORT,
        reportDigest: 'digest-atomic',
        createdAtMs: 700
      })
    ).toThrow(/cannot be rejected from approved/)

    expect(store.listPlanReviews(WATCHER_ID)).toEqual([])
  })
})
