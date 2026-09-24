import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PlanReviewReport } from '../../shared/fork-heimdall-objective/plan-review-schema'
import type { PlannerReport } from '../../shared/fork-heimdall-objective/plan-schema'
import { ObjectiveDatabase } from './objective-database'
import { ObjectiveStore } from './objective-store'
import { resolvePlanReviewDelta } from './plan-review-delta'

const WATCHER_ID = 'watcher-plan-review-delta-1'

function plan(overrides: Partial<PlannerReport> = {}): PlannerReport {
  return {
    plan: [
      {
        taskKey: 'node-1',
        title: 'Node 1',
        spec: 'Execute node one',
        deps: [],
        criteria: [{ body: 'Node works', shellCheckable: false, checkCommand: null }],
        declaresDependencyChange: false
      }
    ],
    assumptions: [{ claim: 'The fixture already exists.', dependentTaskKeys: ['node-1'] }],
    ...overrides
  }
}

function reviseReport(overrides: Partial<PlanReviewReport> = {}): PlanReviewReport {
  return {
    verdict: 'revise',
    assumptions: [{ index: 0, status: 'verified', evidence: 'Confirmed.' }],
    findings: [{ taskKey: 'node-1', severity: 'blocking', body: 'Sizing is off.' }],
    summary: 'Needs another pass.',
    ...overrides
  }
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

function ingestRevision(revisionNumber: number, report: PlannerReport, dispatchId: string) {
  return store.ingestPlan({
    watcherId: WATCHER_ID,
    revisionNumber,
    dispatchId,
    report,
    digest: `digest-${revisionNumber}`,
    createdAtMs: revisionNumber
  })
}

describe('resolvePlanReviewDelta', () => {
  it('returns null for a patch target, always a full review', () => {
    expect(
      resolvePlanReviewDelta(store, WATCHER_ID, { kind: 'patch', patchId: 'patch-1' }, 2)
    ).toBeNull()
  })

  it('returns null for a round-1 revision review', () => {
    const revision = ingestRevision(1, plan(), 'planner-1')
    expect(
      resolvePlanReviewDelta(
        store,
        WATCHER_ID,
        { kind: 'revision', revisionId: revision.revisionId },
        1
      )
    ).toBeNull()
  })

  it('returns null at round 2 when no round-1 revise review exists for a prior revision', () => {
    const revision = ingestRevision(1, plan(), 'planner-1')
    expect(
      resolvePlanReviewDelta(
        store,
        WATCHER_ID,
        { kind: 'revision', revisionId: revision.revisionId },
        2
      )
    ).toBeNull()
  })

  it('resolves a delta once round 2 follows a round-1 revise of the previous revision', () => {
    const first = ingestRevision(1, plan(), 'planner-1')
    store.recordPlanReviewAndRejectRoundOneTarget({
      watcherId: WATCHER_ID,
      targetKind: 'revision',
      targetId: first.revisionId,
      round: 1,
      dispatchId: 'review-1',
      report: reviseReport(),
      reportDigest: 'review-digest-1',
      createdAtMs: 2
    })
    const second = ingestRevision(
      2,
      plan({
        plan: [
          ...plan().plan,
          {
            taskKey: 'node-2',
            title: 'Node 2',
            spec: 'Execute node two',
            deps: [],
            criteria: [{ body: 'Node 2 works', shellCheckable: false, checkCommand: null }],
            declaresDependencyChange: false
          }
        ]
      }),
      'planner-2'
    )

    const delta = resolvePlanReviewDelta(
      store,
      WATCHER_ID,
      { kind: 'revision', revisionId: second.revisionId },
      2
    )

    expect(delta).not.toBeNull()
    expect(delta?.previousReport.verdict).toBe('revise')
    expect(delta?.diff.added).toEqual(['node-2'])
    expect(delta?.diff.unchanged).toEqual(['node-1'])
    expect(delta?.diff.fullReviewRequired).toBe(false)
  })

  it('marks a current assumption carry-eligible when its claim and dependents match a verified prior one', () => {
    const first = ingestRevision(1, plan(), 'planner-1')
    store.recordPlanReviewAndRejectRoundOneTarget({
      watcherId: WATCHER_ID,
      targetKind: 'revision',
      targetId: first.revisionId,
      round: 1,
      dispatchId: 'review-1',
      report: reviseReport(),
      reportDigest: 'review-digest-1',
      createdAtMs: 2
    })
    // node-1 is unchanged and the assumption claim is identical (trimmed) to the verified prior one.
    const second = ingestRevision(
      2,
      plan({
        assumptions: [{ claim: '  The fixture already exists.  ', dependentTaskKeys: ['node-1'] }]
      }),
      'planner-2'
    )

    const delta = resolvePlanReviewDelta(
      store,
      WATCHER_ID,
      { kind: 'revision', revisionId: second.revisionId },
      2
    )

    expect(delta?.carryEligible).toEqual([0])
  })

  it('excludes a current assumption whose dependents touch a changed task', () => {
    // two tasks so retitling one alone stays at the 50% boundary, not over it.
    function twoTaskPlan(nodeOneTitle: string): PlannerReport {
      return {
        plan: [
          {
            taskKey: 'node-1',
            title: nodeOneTitle,
            spec: 'Execute node one',
            deps: [],
            criteria: [{ body: 'Node works', shellCheckable: false, checkCommand: null }],
            declaresDependencyChange: false
          },
          {
            taskKey: 'node-2',
            title: 'Node 2',
            spec: 'Execute node two',
            deps: [],
            criteria: [{ body: 'Node 2 works', shellCheckable: false, checkCommand: null }],
            declaresDependencyChange: false
          }
        ],
        assumptions: [{ claim: 'The fixture already exists.', dependentTaskKeys: ['node-1'] }]
      }
    }
    const first = ingestRevision(1, twoTaskPlan('Node 1'), 'planner-1')
    store.recordPlanReviewAndRejectRoundOneTarget({
      watcherId: WATCHER_ID,
      targetKind: 'revision',
      targetId: first.revisionId,
      round: 1,
      dispatchId: 'review-1',
      report: reviseReport(),
      reportDigest: 'review-digest-1',
      createdAtMs: 2
    })
    const second = ingestRevision(2, twoTaskPlan('Node 1 (retitled)'), 'planner-2')

    const delta = resolvePlanReviewDelta(
      store,
      WATCHER_ID,
      { kind: 'revision', revisionId: second.revisionId },
      2
    )

    expect(delta?.diff.changed).toEqual(['node-1'])
    expect(delta?.diff.fullReviewRequired).toBe(false)
    expect(delta?.carryEligible).toEqual([])
  })

  it('excludes a current assumption whose claim does not match a prior verified one', () => {
    const first = ingestRevision(1, plan(), 'planner-1')
    store.recordPlanReviewAndRejectRoundOneTarget({
      watcherId: WATCHER_ID,
      targetKind: 'revision',
      targetId: first.revisionId,
      round: 1,
      dispatchId: 'review-1',
      report: reviseReport(),
      reportDigest: 'review-digest-1',
      createdAtMs: 2
    })
    const second = ingestRevision(
      2,
      plan({ assumptions: [{ claim: 'A brand new claim.', dependentTaskKeys: ['node-1'] }] }),
      'planner-2'
    )

    const delta = resolvePlanReviewDelta(
      store,
      WATCHER_ID,
      { kind: 'revision', revisionId: second.revisionId },
      2
    )

    expect(delta?.carryEligible).toEqual([])
  })

  it('falls back to a full review (null) when more than half the plan changed', () => {
    const first = ingestRevision(
      1,
      plan({
        plan: [
          ...plan().plan,
          {
            taskKey: 'node-2',
            title: 'Node 2',
            spec: 'Execute node two',
            deps: [],
            criteria: [{ body: 'Node 2 works', shellCheckable: false, checkCommand: null }],
            declaresDependencyChange: false
          }
        ]
      }),
      'planner-1'
    )
    store.recordPlanReviewAndRejectRoundOneTarget({
      watcherId: WATCHER_ID,
      targetKind: 'revision',
      targetId: first.revisionId,
      round: 1,
      dispatchId: 'review-1',
      report: reviseReport(),
      reportDigest: 'review-digest-1',
      createdAtMs: 2
    })
    const second = ingestRevision(
      2,
      plan({
        plan: [
          {
            taskKey: 'node-1',
            title: 'Node 1 rewritten',
            spec: 'Execute node one differently',
            deps: [],
            criteria: [
              { body: 'Node works differently', shellCheckable: false, checkCommand: null }
            ],
            declaresDependencyChange: false
          },
          {
            taskKey: 'node-3',
            title: 'Node 3',
            spec: 'Execute node three',
            deps: [],
            criteria: [{ body: 'Node 3 works', shellCheckable: false, checkCommand: null }],
            declaresDependencyChange: false
          }
        ]
      }),
      'planner-2'
    )

    expect(
      resolvePlanReviewDelta(
        store,
        WATCHER_ID,
        { kind: 'revision', revisionId: second.revisionId },
        2
      )
    ).toBeNull()
  })
})
