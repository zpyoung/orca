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
