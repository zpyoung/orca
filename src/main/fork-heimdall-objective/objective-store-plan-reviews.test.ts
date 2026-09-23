import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PlanReviewReport } from '../../shared/fork-heimdall-objective/plan-review-schema'
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

    const record = store.recordPlanReview(args)
    expect(record.report).toEqual(APPROVE_REPORT)
    expect(store.recordPlanReview(args)).toEqual(record)
    expect(store.getPlanReviewReport(record.id)).toEqual(APPROVE_REPORT)
    expect(store.getPlanReviewReport('missing-id')).toBeNull()
  })

  it('refuses a second dispatch for the same target and round', () => {
    store.recordPlanReview({
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
      store.recordPlanReview({
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
    store.recordPlanReview({
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
      store.recordPlanReview({
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
    const first = store.recordPlanReview({
      watcherId: WATCHER_ID,
      targetKind: 'patch',
      targetId: 'patch-1',
      round: 1,
      dispatchId: 'plan-review-round-1',
      report: REVISE_REPORT,
      reportDigest: 'digest-1',
      createdAtMs: 500
    })
    const second = store.recordPlanReview({
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
      store.recordPlanReview({
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
