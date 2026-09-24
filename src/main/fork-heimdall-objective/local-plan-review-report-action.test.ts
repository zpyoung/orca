import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import type { ExecuteContext } from '../../shared/fork-heimdall/kind-contract'
import type { ObjectiveAction } from '../../shared/fork-heimdall-objective/objective-actions'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import type { PlannerReport } from '../../shared/fork-heimdall-objective/plan-schema'
import type { ObjectiveSnapshotBinding } from './execution-context'
import { ingestObjectivePlanReviewReport } from './local-plan-review-report-action'
import { ObjectiveDatabase } from './objective-database'
import { ObjectiveStore } from './objective-store'
import { issueObjectiveReportPath } from './report-ingestion'

const WATCHER_ID = 'watcher-1'
const PLAN: PlannerReport = {
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
  assumptions: [{ claim: 'The fixture already exists.', dependentTaskKeys: ['node-1'] }]
}

const opened: ObjectiveDatabase[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const item of opened.splice(0)) {
    item.close()
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function fixture() {
  const database = new ObjectiveDatabase(':memory:')
  opened.push(database)
  return { objectiveStore: new ObjectiveStore(database), target: await folderTarget() }
}

async function folderTarget() {
  const workspacePath = await mkdtemp(join(tmpdir(), 'objective-plan-review-ingest-'))
  temporaryDirectories.push(workspacePath)
  return {
    kind: 'folder' as const,
    executionHostId: 'local' as const,
    workspacePath,
    fileProvider: null
  }
}

function planReviewReport(
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    verdict: 'approve',
    assumptions: [{ index: 0, status: 'verified', evidence: 'Confirmed in src/node-1.ts.' }],
    findings: [],
    summary: 'The plan is sound.',
    ...overrides
  }
}

describe('ingestObjectivePlanReviewReport', () => {
  it('records an approving plan review for a draft revision', async () => {
    const { objectiveStore, target } = await fixture()
    const revision = objectiveStore.ingestPlan({
      watcherId: WATCHER_ID,
      revisionNumber: 1,
      dispatchId: 'planner-1',
      report: PLAN,
      digest: 'digest-1',
      createdAtMs: 1
    })
    const dispatchAction = {
      kind: 'dispatch-plan-review',
      capability: 'review',
      visibility: 'local',
      contentIdentity: 'content-1',
      evidenceKey: `${revision.revisionId}:1`,
      target: { kind: 'revision', revisionId: revision.revisionId },
      round: 1
    } satisfies ObjectiveAction
    const fingerprint = makeAttemptFingerprint(
      dispatchAction.contentIdentity,
      dispatchAction.kind,
      dispatchAction.evidenceKey
    )
    const reportPath = await issueObjectiveReportPath(target, fingerprint)
    await writeFile(reportPath, JSON.stringify(planReviewReport()))
    const ingestAction = {
      kind: 'ingest-plan-review',
      capability: 'review',
      visibility: 'local',
      contentIdentity: 'content-1',
      evidenceKey: 'dispatch-plan-review-1',
      recovery: 'replay-safe',
      dispatchId: 'dispatch-plan-review-1',
      reportPath,
      target: { kind: 'revision', revisionId: revision.revisionId }
    } satisfies ObjectiveAction
    const binding = {
      enrollment: { watcherId: WATCHER_ID },
      target
    } as unknown as ObjectiveSnapshotBinding
    const context = {
      ledger: {
        watcherId: WATCHER_ID,
        entries: [
          attemptEntry(dispatchAction, fingerprint, 'dispatch-plan-review-1'),
          workerDoneEvidence('dispatch-plan-review-1', reportPath)
        ]
      },
      lease: { assertHeld: vi.fn(async () => undefined) }
    } as unknown as ExecuteContext<ObjectiveWorld>

    const outcome = await ingestObjectivePlanReviewReport({
      action: ingestAction,
      binding,
      context,
      objectiveStore
    })

    expect(outcome).toMatchObject({
      effect: 'landed',
      result: { kind: 'plan-review-ingested', verdict: 'approve' }
    })
    expect(objectiveStore.listPlanReviews(WATCHER_ID)).toHaveLength(1)
    expect(objectiveStore.project(WATCHER_ID).revisions[0]?.status).toBe('draft')
  })

  it('rejects the draft revision when round 1 comes back revise', async () => {
    const { objectiveStore, target } = await fixture()
    const revision = objectiveStore.ingestPlan({
      watcherId: WATCHER_ID,
      revisionNumber: 1,
      dispatchId: 'planner-1',
      report: PLAN,
      digest: 'digest-1',
      createdAtMs: 1
    })
    const dispatchAction = {
      kind: 'dispatch-plan-review',
      capability: 'review',
      visibility: 'local',
      contentIdentity: 'content-1',
      evidenceKey: `${revision.revisionId}:1`,
      target: { kind: 'revision', revisionId: revision.revisionId },
      round: 1
    } satisfies ObjectiveAction
    const fingerprint = makeAttemptFingerprint(
      dispatchAction.contentIdentity,
      dispatchAction.kind,
      dispatchAction.evidenceKey
    )
    const reportPath = await issueObjectiveReportPath(target, fingerprint)
    await writeFile(
      reportPath,
      JSON.stringify(
        planReviewReport({
          verdict: 'revise',
          assumptions: [{ index: 0, status: 'unverified', evidence: 'Could not confirm.' }],
          findings: [{ taskKey: 'node-1', severity: 'blocking', body: 'Sizing is off.' }]
        })
      )
    )
    const ingestAction = {
      kind: 'ingest-plan-review',
      capability: 'review',
      visibility: 'local',
      contentIdentity: 'content-1',
      evidenceKey: 'dispatch-plan-review-1',
      recovery: 'replay-safe',
      dispatchId: 'dispatch-plan-review-1',
      reportPath,
      target: { kind: 'revision', revisionId: revision.revisionId }
    } satisfies ObjectiveAction
    const binding = {
      enrollment: { watcherId: WATCHER_ID },
      target
    } as unknown as ObjectiveSnapshotBinding
    const context = {
      ledger: {
        watcherId: WATCHER_ID,
        entries: [
          attemptEntry(dispatchAction, fingerprint, 'dispatch-plan-review-1'),
          workerDoneEvidence('dispatch-plan-review-1', reportPath)
        ]
      },
      lease: { assertHeld: vi.fn(async () => undefined) }
    } as unknown as ExecuteContext<ObjectiveWorld>

    const outcome = await ingestObjectivePlanReviewReport({
      action: ingestAction,
      binding,
      context,
      objectiveStore
    })

    expect(outcome).toMatchObject({ effect: 'landed', result: { verdict: 'revise' } })
    expect(objectiveStore.project(WATCHER_ID).revisions[0]?.status).toBe('rejected')
  })

  it('leaves the target untouched when a revise verdict lands on round 2', async () => {
    const { objectiveStore, target } = await fixture()
    const revision = objectiveStore.ingestPlan({
      watcherId: WATCHER_ID,
      revisionNumber: 1,
      dispatchId: 'planner-1',
      report: PLAN,
      digest: 'digest-1',
      createdAtMs: 1
    })
    const dispatchAction = {
      kind: 'dispatch-plan-review',
      capability: 'review',
      visibility: 'local',
      contentIdentity: 'content-1',
      evidenceKey: `${revision.revisionId}:2`,
      target: { kind: 'revision', revisionId: revision.revisionId },
      round: 2
    } satisfies ObjectiveAction
    const fingerprint = makeAttemptFingerprint(
      dispatchAction.contentIdentity,
      dispatchAction.kind,
      dispatchAction.evidenceKey
    )
    const reportPath = await issueObjectiveReportPath(target, fingerprint)
    await writeFile(
      reportPath,
      JSON.stringify(
        planReviewReport({
          verdict: 'revise',
          assumptions: [{ index: 0, status: 'unverified', evidence: 'Could not confirm.' }],
          findings: [{ taskKey: 'node-1', severity: 'blocking', body: 'Still too big.' }]
        })
      )
    )
    const ingestAction = {
      kind: 'ingest-plan-review',
      capability: 'review',
      visibility: 'local',
      contentIdentity: 'content-1',
      evidenceKey: 'dispatch-plan-review-2',
      recovery: 'replay-safe',
      dispatchId: 'dispatch-plan-review-2',
      reportPath,
      target: { kind: 'revision', revisionId: revision.revisionId }
    } satisfies ObjectiveAction
    const binding = {
      enrollment: { watcherId: WATCHER_ID },
      target
    } as unknown as ObjectiveSnapshotBinding
    const context = {
      ledger: {
        watcherId: WATCHER_ID,
        entries: [
          attemptEntry(dispatchAction, fingerprint, 'dispatch-plan-review-2'),
          workerDoneEvidence('dispatch-plan-review-2', reportPath)
        ]
      },
      lease: { assertHeld: vi.fn(async () => undefined) }
    } as unknown as ExecuteContext<ObjectiveWorld>

    const outcome = await ingestObjectivePlanReviewReport({
      action: ingestAction,
      binding,
      context,
      objectiveStore
    })

    expect(outcome).toMatchObject({ effect: 'landed', result: { verdict: 'revise' } })
    expect(objectiveStore.project(WATCHER_ID).revisions[0]?.status).toBe('draft')
  })

  it('rejects a pending patch when round 1 comes back revise', async () => {
    const { objectiveStore, target } = await fixture()
    const revision = objectiveStore.ingestPlan({
      watcherId: WATCHER_ID,
      revisionNumber: 1,
      dispatchId: 'planner-1',
      report: PLAN,
      digest: 'digest-1',
      createdAtMs: 1
    })
    objectiveStore.activatePlan({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      digest: revision.digest,
      approvedAtMs: 2
    })
    const patch = objectiveStore.ingestPlanPatch({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      dispatchId: 'planner-repair-1',
      repairOrdinal: 1,
      report: {
        repair: {
          upsertTasks: [
            {
              taskKey: 'follow-up',
              title: 'Follow up',
              spec: 'Do the follow-up work',
              deps: [],
              criteria: [{ body: 'Follow-up is done', shellCheckable: false, checkCommand: null }],
              declaresDependencyChange: false
            }
          ],
          dropTaskKeys: []
        },
        assumptions: [{ claim: 'The follow-up fixture exists.', dependentTaskKeys: ['follow-up'] }]
      },
      createdAtMs: 3
    })
    const dispatchAction = {
      kind: 'dispatch-plan-review',
      capability: 'review',
      visibility: 'local',
      contentIdentity: 'content-1',
      evidenceKey: `${patch.id}:1`,
      target: { kind: 'patch', patchId: patch.id },
      round: 1
    } satisfies ObjectiveAction
    const fingerprint = makeAttemptFingerprint(
      dispatchAction.contentIdentity,
      dispatchAction.kind,
      dispatchAction.evidenceKey
    )
    const reportPath = await issueObjectiveReportPath(target, fingerprint)
    await writeFile(
      reportPath,
      JSON.stringify(
        planReviewReport({
          verdict: 'revise',
          assumptions: [{ index: 0, status: 'unverified', evidence: 'Could not confirm.' }],
          findings: [{ taskKey: 'follow-up', severity: 'blocking', body: 'Sizing is off.' }]
        })
      )
    )
    const ingestAction = {
      kind: 'ingest-plan-review',
      capability: 'review',
      visibility: 'local',
      contentIdentity: 'content-1',
      evidenceKey: 'dispatch-plan-review-patch-1',
      recovery: 'replay-safe',
      dispatchId: 'dispatch-plan-review-patch-1',
      reportPath,
      target: { kind: 'patch', patchId: patch.id }
    } satisfies ObjectiveAction
    const binding = {
      enrollment: { watcherId: WATCHER_ID },
      target
    } as unknown as ObjectiveSnapshotBinding
    const context = {
      ledger: {
        watcherId: WATCHER_ID,
        entries: [
          attemptEntry(dispatchAction, fingerprint, 'dispatch-plan-review-patch-1'),
          workerDoneEvidence('dispatch-plan-review-patch-1', reportPath)
        ]
      },
      lease: { assertHeld: vi.fn(async () => undefined) }
    } as unknown as ExecuteContext<ObjectiveWorld>

    const outcome = await ingestObjectivePlanReviewReport({
      action: ingestAction,
      binding,
      context,
      objectiveStore
    })

    expect(outcome).toMatchObject({ effect: 'landed', result: { verdict: 'revise' } })
    const rejected = objectiveStore.getPlanPatch(patch.id)
    expect(rejected?.status).toBe('rejected')
    expect(rejected?.rejection).toBe('plan-review-revise')
  })

  it('rejects an ingest action whose target does not match its originating dispatch', async () => {
    const { objectiveStore, target } = await fixture()
    const revision = objectiveStore.ingestPlan({
      watcherId: WATCHER_ID,
      revisionNumber: 1,
      dispatchId: 'planner-1',
      report: PLAN,
      digest: 'digest-1',
      createdAtMs: 1
    })
    const dispatchAction = {
      kind: 'dispatch-plan-review',
      capability: 'review',
      visibility: 'local',
      contentIdentity: 'content-1',
      evidenceKey: `${revision.revisionId}:1`,
      target: { kind: 'revision', revisionId: revision.revisionId },
      round: 1
    } satisfies ObjectiveAction
    const fingerprint = makeAttemptFingerprint(
      dispatchAction.contentIdentity,
      dispatchAction.kind,
      dispatchAction.evidenceKey
    )
    const ingestAction = {
      kind: 'ingest-plan-review',
      capability: 'review',
      visibility: 'local',
      contentIdentity: 'content-1',
      evidenceKey: 'dispatch-plan-review-1',
      recovery: 'replay-safe',
      dispatchId: 'dispatch-plan-review-1',
      reportPath: '/outside/report.json',
      target: { kind: 'revision', revisionId: 'a-different-revision' }
    } satisfies ObjectiveAction
    const binding = {
      enrollment: { watcherId: WATCHER_ID },
      target
    } as unknown as ObjectiveSnapshotBinding
    const context = {
      ledger: {
        watcherId: WATCHER_ID,
        entries: [attemptEntry(dispatchAction, fingerprint, 'dispatch-plan-review-1')]
      },
      lease: { assertHeld: vi.fn(async () => undefined) }
    } as unknown as ExecuteContext<ObjectiveWorld>

    const outcome = await ingestObjectivePlanReviewReport({
      action: ingestAction,
      binding,
      context,
      objectiveStore
    })

    expect(outcome).toMatchObject({ effect: 'not-landed', reason: 'plan-review-dispatch-mismatch' })
  })
})

function evidencedAssumptionsPlan(count: number): PlannerReport {
  return {
    plan: PLAN.plan,
    assumptions: Array.from({ length: count }, (_, index) => ({
      claim: `Assumption ${index} holds.`,
      dependentTaskKeys: ['node-1'],
      evidence: { command: `check-${index}`, observed: `confirmed ${index}` }
    }))
  }
}

function plainAssumptionsPlan(count: number): PlannerReport {
  return {
    plan: PLAN.plan,
    assumptions: Array.from({ length: count }, (_, index) => ({
      claim: `Assumption ${index} holds.`,
      dependentTaskKeys: ['node-1']
    }))
  }
}

function basisAssessments(total: number, reverifiedCount: number): Record<string, unknown>[] {
  return Array.from({ length: total }, (_, index) => ({
    index,
    status: 'verified',
    evidence: `Spot-checked ${index}.`,
    basis: index < reverifiedCount ? 'reverified' : 'planner-evidence'
  }))
}

async function ingestPlanReview(
  id: string,
  report: PlannerReport,
  assessments: readonly Record<string, unknown>[]
) {
  const { objectiveStore, target } = await fixture()
  const revision = objectiveStore.ingestPlan({
    watcherId: WATCHER_ID,
    revisionNumber: 1,
    dispatchId: `planner-${id}`,
    report,
    digest: `digest-${id}`,
    createdAtMs: 1
  })
  const dispatchAction = {
    kind: 'dispatch-plan-review',
    capability: 'review',
    visibility: 'local',
    contentIdentity: 'content-1',
    evidenceKey: `${revision.revisionId}:1`,
    target: { kind: 'revision', revisionId: revision.revisionId },
    round: 1
  } satisfies ObjectiveAction
  const fingerprint = makeAttemptFingerprint(
    dispatchAction.contentIdentity,
    dispatchAction.kind,
    dispatchAction.evidenceKey
  )
  const reportPath = await issueObjectiveReportPath(target, fingerprint)
  await writeFile(
    reportPath,
    JSON.stringify({
      verdict: 'approve',
      assumptions: assessments,
      findings: [],
      summary: 'Spot-checked as required.'
    })
  )
  const dispatchId = `dispatch-plan-review-${id}`
  const ingestAction = {
    kind: 'ingest-plan-review',
    capability: 'review',
    visibility: 'local',
    contentIdentity: 'content-1',
    evidenceKey: dispatchId,
    recovery: 'replay-safe',
    dispatchId,
    reportPath,
    target: { kind: 'revision', revisionId: revision.revisionId }
  } satisfies ObjectiveAction
  const binding = {
    enrollment: { watcherId: WATCHER_ID },
    target
  } as unknown as ObjectiveSnapshotBinding
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this action only reads context.ledger and context.lease; ExecuteContext's snapshot/dispatchWorker fields are unused here and not worth faking.
  const context = {
    ledger: {
      watcherId: WATCHER_ID,
      entries: [
        attemptEntry(dispatchAction, fingerprint, dispatchId),
        workerDoneEvidence(dispatchId, reportPath)
      ]
    },
    lease: { assertHeld: vi.fn(async () => undefined) }
  } as unknown as ExecuteContext<ObjectiveWorld>

  return ingestObjectivePlanReviewReport({ action: ingestAction, binding, context, objectiveStore })
}

describe('ingestObjectivePlanReviewReport spot-check basis validation', () => {
  it.each([
    [0, 0],
    [1, 1],
    [2, 2],
    [8, 2],
    [9, 3]
  ])(
    'requires %i reverified of %i evidenced assumptions to land',
    async (evidencedCount, required) => {
      const landed = await ingestPlanReview(
        `ok-${evidencedCount}`,
        evidencedAssumptionsPlan(evidencedCount),
        basisAssessments(evidencedCount, required)
      )
      expect(landed.effect).toBe('landed')

      if (required > 0) {
        const rejected = await ingestPlanReview(
          `short-${evidencedCount}`,
          evidencedAssumptionsPlan(evidencedCount),
          basisAssessments(evidencedCount, required - 1)
        )
        expect(rejected).toMatchObject({
          effect: 'not-landed',
          reason: 'plan-review-report-semantic-invalid'
        })
      }
    }
  )

  it('rejects basis:planner-evidence on an assumption the planner recorded no evidence for', async () => {
    const outcome = await ingestPlanReview('unsupported-basis', plainAssumptionsPlan(1), [
      { index: 0, status: 'verified', evidence: 'trusted', basis: 'planner-evidence' }
    ])
    expect(outcome).toMatchObject({
      effect: 'not-landed',
      reason: 'plan-review-report-semantic-invalid'
    })
  })

  it("rejects basis:'carried' in this task", async () => {
    const outcome = await ingestPlanReview('carried-basis', evidencedAssumptionsPlan(1), [
      { index: 0, status: 'verified', evidence: 'carried forward', basis: 'carried' }
    ])
    expect(outcome).toMatchObject({
      effect: 'not-landed',
      reason: 'plan-review-report-semantic-invalid'
    })
  })
})

function attemptEntry(
  action: ObjectiveAction,
  fingerprint: string,
  dispatchId: string
): ExecuteContext<ObjectiveWorld>['ledger']['entries'][number] {
  return {
    eventId: `attempt-${dispatchId}`,
    watcherId: WATCHER_ID,
    atMs: 1,
    origin: 'owner',
    class: 'fact',
    kind: 'attempt',
    attemptId: `attempt-${dispatchId}`,
    fingerprint,
    action,
    state: 'settled',
    effect: 'indeterminate',
    dispatch: { spec: 'Review the plan.', deps: [], dispatchKind: 'reviewer' },
    dispatchId
  } as unknown as ExecuteContext<ObjectiveWorld>['ledger']['entries'][number]
}

function workerDoneEvidence(
  dispatchId: string,
  reportPath: string
): ExecuteContext<ObjectiveWorld>['ledger']['entries'][number] {
  return {
    eventId: `evidence-${dispatchId}`,
    watcherId: WATCHER_ID,
    atMs: 2,
    origin: 'owner',
    class: 'fact',
    kind: 'evidence',
    evidenceKind: 'orchestration-mailbox',
    payload: {
      type: 'worker_done',
      payload: { dispatchId, outcome: 'succeeded', reportPath, filesModified: [] }
    }
  } as unknown as ExecuteContext<ObjectiveWorld>['ledger']['entries'][number]
}

function deltaAssumptionsPlan(claims: readonly string[]): PlannerReport {
  return {
    plan: PLAN.plan,
    assumptions: claims.map((claim, index) => ({
      claim,
      dependentTaskKeys: ['node-1'],
      evidence: { command: `check-${index}`, observed: `confirmed ${index}` }
    }))
  }
}

const DELTA_CLAIMS = Array.from({ length: 8 }, (_, index) => `Assumption ${index} holds.`)

async function seedDeltaRevisions(objectiveStore: ObjectiveStore) {
  const first = objectiveStore.ingestPlan({
    watcherId: WATCHER_ID,
    revisionNumber: 1,
    dispatchId: 'planner-1',
    report: deltaAssumptionsPlan(DELTA_CLAIMS),
    digest: 'digest-1',
    createdAtMs: 1
  })
  objectiveStore.recordPlanReviewAndRejectRoundOneTarget({
    watcherId: WATCHER_ID,
    targetKind: 'revision',
    targetId: first.revisionId,
    round: 1,
    dispatchId: 'review-1',
    report: {
      verdict: 'revise',
      assumptions: DELTA_CLAIMS.map((_, index) => ({
        index,
        status: index === 0 ? 'verified' : 'unverified',
        evidence: index === 0 ? 'Confirmed in src/node-1.ts.' : 'Could not confirm.'
      })),
      findings: [{ taskKey: 'node-1', severity: 'blocking', body: 'Sizing is off.' }],
      summary: 'Needs another pass.'
    },
    reportDigest: 'review-digest-1',
    createdAtMs: 2
  })
  // adds a task so churn stays under the 50% full-review threshold while keeping node-1 unchanged.
  const second = objectiveStore.ingestPlan({
    watcherId: WATCHER_ID,
    revisionNumber: 2,
    dispatchId: 'planner-2',
    report: {
      plan: [
        ...deltaAssumptionsPlan(DELTA_CLAIMS).plan,
        {
          taskKey: 'node-2',
          title: 'Node 2',
          spec: 'Execute node two',
          deps: [],
          criteria: [{ body: 'Node 2 works', shellCheckable: false, checkCommand: null }],
          declaresDependencyChange: false
        }
      ],
      assumptions: deltaAssumptionsPlan(DELTA_CLAIMS).assumptions
    },
    digest: 'digest-2',
    createdAtMs: 3
  })
  return second
}

async function ingestRoundTwoDeltaReview(
  assessments: readonly Record<string, unknown>[],
  verdict: 'approve' | 'revise' | 'escalate' = 'approve'
) {
  const { objectiveStore, target } = await fixture()
  const second = await seedDeltaRevisions(objectiveStore)
  const dispatchAction = {
    kind: 'dispatch-plan-review',
    capability: 'review',
    visibility: 'local',
    contentIdentity: 'content-2',
    evidenceKey: `${second.revisionId}:2`,
    target: { kind: 'revision', revisionId: second.revisionId },
    round: 2
  } satisfies ObjectiveAction
  const fingerprint = makeAttemptFingerprint(
    dispatchAction.contentIdentity,
    dispatchAction.kind,
    dispatchAction.evidenceKey
  )
  const reportPath = await issueObjectiveReportPath(target, fingerprint)
  await writeFile(
    reportPath,
    JSON.stringify({ verdict, assumptions: assessments, findings: [], summary: 'Delta review.' })
  )
  const dispatchId = 'dispatch-plan-review-2'
  const ingestAction = {
    kind: 'ingest-plan-review',
    capability: 'review',
    visibility: 'local',
    contentIdentity: 'content-2',
    evidenceKey: dispatchId,
    recovery: 'replay-safe',
    dispatchId,
    reportPath,
    target: { kind: 'revision', revisionId: second.revisionId }
  } satisfies ObjectiveAction
  const binding = {
    enrollment: { watcherId: WATCHER_ID },
    target
  } as unknown as ObjectiveSnapshotBinding
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this action only reads context.ledger and context.lease; ExecuteContext's snapshot/dispatchWorker fields are unused here and not worth faking.
  const context = {
    ledger: {
      watcherId: WATCHER_ID,
      entries: [
        attemptEntry(dispatchAction, fingerprint, dispatchId),
        workerDoneEvidence(dispatchId, reportPath)
      ]
    },
    lease: { assertHeld: vi.fn(async () => undefined) }
  } as unknown as ExecuteContext<ObjectiveWorld>

  return ingestObjectivePlanReviewReport({ action: ingestAction, binding, context, objectiveStore })
}

describe('ingestObjectivePlanReviewReport delta carryEligible', () => {
  it("accepts basis:'carried' at the index the delta recomputes as carry-eligible", async () => {
    const outcome = await ingestRoundTwoDeltaReview([
      { index: 0, status: 'verified', evidence: 'Carried from round 1.', basis: 'carried' },
      { index: 1, status: 'verified', evidence: 'Re-checked.', basis: 'reverified' },
      { index: 2, status: 'verified', evidence: 'Re-checked.', basis: 'reverified' },
      {
        index: 3,
        status: 'verified',
        evidence: 'Trusted planner evidence.',
        basis: 'planner-evidence'
      },
      {
        index: 4,
        status: 'verified',
        evidence: 'Trusted planner evidence.',
        basis: 'planner-evidence'
      },
      {
        index: 5,
        status: 'verified',
        evidence: 'Trusted planner evidence.',
        basis: 'planner-evidence'
      },
      {
        index: 6,
        status: 'verified',
        evidence: 'Trusted planner evidence.',
        basis: 'planner-evidence'
      },
      {
        index: 7,
        status: 'verified',
        evidence: 'Trusted planner evidence.',
        basis: 'planner-evidence'
      }
    ])

    expect(outcome).toMatchObject({ effect: 'landed', result: { verdict: 'approve' } })
  })

  it("rejects basis:'carried' at an index the delta does not recompute as carry-eligible", async () => {
    const outcome = await ingestRoundTwoDeltaReview([
      { index: 0, status: 'verified', evidence: 'Re-checked.', basis: 'reverified' },
      { index: 1, status: 'verified', evidence: 'Re-checked.', basis: 'reverified' },
      {
        index: 2,
        status: 'verified',
        evidence: 'Trusted planner evidence.',
        basis: 'planner-evidence'
      },
      { index: 3, status: 'verified', evidence: 'Carried incorrectly.', basis: 'carried' },
      {
        index: 4,
        status: 'verified',
        evidence: 'Trusted planner evidence.',
        basis: 'planner-evidence'
      },
      {
        index: 5,
        status: 'verified',
        evidence: 'Trusted planner evidence.',
        basis: 'planner-evidence'
      },
      {
        index: 6,
        status: 'verified',
        evidence: 'Trusted planner evidence.',
        basis: 'planner-evidence'
      },
      {
        index: 7,
        status: 'verified',
        evidence: 'Trusted planner evidence.',
        basis: 'planner-evidence'
      }
    ])

    expect(outcome).toMatchObject({
      effect: 'not-landed',
      reason: 'plan-review-report-semantic-invalid'
    })
  })
})
