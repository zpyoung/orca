import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import type { ExecuteContext } from '../../shared/fork-heimdall/kind-contract'
import type { ObjectiveAction } from '../../shared/fork-heimdall-objective/objective-actions'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import type { PlannerReport } from '../../shared/fork-heimdall-objective/plan-schema'
import { ingestObjectivePlanReport } from './local-plan-report-action'
import { ObjectiveDatabase } from './objective-database'
import type { ObjectiveSnapshotBinding } from './execution-context'
import { ObjectiveStore } from './objective-store'

// the read pipeline resolves and schema-validates the report file by role; these tests exercise
// repair-shaped ingestion's own logic once a report has been read, independent of that pipeline
const { readReport } = vi.hoisted(() => ({ readReport: vi.fn() }))
vi.mock('./report-ingestion', () => ({
  issueObjectiveReportPath: vi.fn(),
  readObjectiveRoleReport: readReport
}))

const WATCHER_ID = 'watcher-1'
const REPORT_PATH = '/outside/repair-report.json'

const PLAN: PlannerReport = {
  plan: [
    {
      taskKey: 'core',
      title: 'Core',
      spec: 'Implement core',
      deps: [],
      criteria: [{ body: 'Core works', shellCheckable: false, checkCommand: null }],
      declaresDependencyChange: false
    },
    {
      taskKey: 'extra',
      title: 'Extra',
      spec: 'Implement extra',
      deps: [],
      criteria: [{ body: 'Extra works', shellCheckable: false, checkCommand: null }],
      declaresDependencyChange: false
    }
  ]
}

const opened: ObjectiveDatabase[] = []

beforeEach(() => {
  readReport.mockReset()
})

afterEach(() => {
  for (const item of opened) {
    item.close()
  }
  opened.length = 0
})

function repairFixture(): {
  objectiveStore: ObjectiveStore
  revisionId: string
  binding: ObjectiveSnapshotBinding
  dispatchAction: ObjectiveAction
  fingerprint: string
  contextWith(extraLedgerEntries?: unknown[]): ExecuteContext<ObjectiveWorld>
} {
  const database = new ObjectiveDatabase(':memory:')
  opened.push(database)
  const objectiveStore = new ObjectiveStore(database)
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
  const binding = {
    enrollment: { watcherId: WATCHER_ID },
    contract: { writeTerritory: ['src/**'] },
    target: {
      kind: 'folder',
      executionHostId: 'local',
      workspacePath: '/workspace',
      fileProvider: null
    }
  } as unknown as ObjectiveSnapshotBinding
  const dispatchAction = {
    kind: 'dispatch-planner',
    capability: 'plan',
    visibility: 'local',
    contentIdentity: 'content-1',
    evidenceKey: 'plan:2:repair',
    revisionNumber: 2,
    reason: 'replan-after-block',
    shape: 'repair',
    repairOrdinal: 1,
    repairRevisionId: revision.revisionId
  } satisfies ObjectiveAction
  const fingerprint = makeAttemptFingerprint(
    dispatchAction.contentIdentity,
    dispatchAction.kind,
    dispatchAction.evidenceKey
  )

  function contextWith(extraLedgerEntries: unknown[] = []): ExecuteContext<ObjectiveWorld> {
    return {
      snapshot: { contentIdentity: 'content-1', world: { plan: { nodes: [] } } },
      ledger: {
        watcherId: WATCHER_ID,
        entries: [
          {
            eventId: 'attempt-planner-repair-1',
            watcherId: WATCHER_ID,
            atMs: 1,
            origin: 'owner',
            class: 'fact',
            kind: 'attempt',
            attemptId: 'attempt-planner-repair-1',
            fingerprint,
            action: dispatchAction,
            state: 'settled',
            effect: 'indeterminate',
            dispatch: { spec: 'Repair the plan.', deps: [], dispatchKind: 'planner' },
            dispatchId: 'dispatch-planner-repair-1'
          },
          {
            eventId: 'evidence-planner-repair-1',
            watcherId: WATCHER_ID,
            atMs: 2,
            origin: 'owner',
            class: 'fact',
            kind: 'evidence',
            evidenceKind: 'orchestration-mailbox',
            payload: {
              type: 'worker_done',
              payload: {
                dispatchId: 'dispatch-planner-repair-1',
                outcome: 'succeeded',
                reportPath: REPORT_PATH,
                filesModified: []
              }
            }
          },
          ...extraLedgerEntries
        ]
      },
      lease: { assertHeld: vi.fn(async () => undefined) },
      dispatchWorker: vi.fn()
    } as unknown as ExecuteContext<ObjectiveWorld>
  }

  return {
    objectiveStore,
    revisionId: revision.revisionId,
    binding,
    dispatchAction,
    fingerprint,
    contextWith
  }
}

type IngestPlanTestAction = Extract<ObjectiveAction, { kind: 'ingest-plan' }>

function ingestAction(
  fixture: ReturnType<typeof repairFixture>,
  overrides: Partial<IngestPlanTestAction> = {}
): IngestPlanTestAction {
  return {
    kind: 'ingest-plan',
    capability: 'plan',
    visibility: 'local',
    contentIdentity: 'content-1',
    evidenceKey: 'dispatch-planner-repair-1',
    recovery: 'replay-safe',
    dispatchId: 'dispatch-planner-repair-1',
    revisionNumber: 2,
    reportPath: REPORT_PATH,
    shape: 'repair',
    targetRevisionId: fixture.revisionId,
    ...overrides
  }
}

describe('objective repair-shaped plan ingestion', () => {
  it('stores a valid repair report as a pending plan patch', async () => {
    const fixture = repairFixture()
    readReport.mockResolvedValue({
      ok: true,
      role: 'planner',
      path: REPORT_PATH,
      report: { repair: { upsertTasks: [], dropTaskKeys: ['extra'] }, assumptions: [] },
      reportDigest: 'digest-repair-1'
    })

    const outcome = await ingestObjectivePlanReport({
      action: ingestAction(fixture),
      binding: fixture.binding,
      context: fixture.contextWith(),
      objectiveStore: fixture.objectiveStore
    })

    expect(outcome).toMatchObject({
      effect: 'landed',
      result: { kind: 'plan-patch-ingested', status: 'pending' }
    })
    const patches = fixture.objectiveStore.listPlanPatches(WATCHER_ID)
    expect(patches).toHaveLength(1)
    expect(patches[0]).toMatchObject({
      status: 'pending',
      repairOrdinal: 1,
      revisionId: fixture.revisionId
    })
  })

  it('stores a semantically invalid repair report as a rejected patch instead of discarding it', async () => {
    const fixture = repairFixture()
    readReport.mockResolvedValue({
      ok: true,
      role: 'planner',
      path: REPORT_PATH,
      report: { repair: { upsertTasks: [], dropTaskKeys: ['does-not-exist'] }, assumptions: [] },
      reportDigest: 'digest-repair-2'
    })

    const outcome = await ingestObjectivePlanReport({
      action: ingestAction(fixture),
      binding: fixture.binding,
      context: fixture.contextWith(),
      objectiveStore: fixture.objectiveStore
    })

    expect(outcome).toMatchObject({ effect: 'landed', result: { kind: 'plan-patch-ingested' } })
    const patches = fixture.objectiveStore.listPlanPatches(WATCHER_ID)
    expect(patches).toHaveLength(1)
    expect(patches[0]?.status).toBe('rejected')
    expect(patches[0]?.rejection).toMatch(/^invalid-report:/)
  })

  it('rejects a repair patch that touches a task with an in-flight dispatch', async () => {
    const fixture = repairFixture()
    readReport.mockResolvedValue({
      ok: true,
      role: 'planner',
      path: REPORT_PATH,
      report: { repair: { upsertTasks: [], dropTaskKeys: ['extra'] }, assumptions: [] },
      reportDigest: 'digest-repair-3'
    })
    const inFlightDispatch = {
      eventId: 'attempt-node-extra',
      watcherId: WATCHER_ID,
      atMs: 3,
      origin: 'owner',
      class: 'fact',
      kind: 'attempt',
      attemptId: 'attempt-node-extra',
      fingerprint: 'fingerprint-node-extra',
      action: {
        kind: 'dispatch-node',
        capability: 'implement',
        visibility: 'local',
        contentIdentity: 'content-1',
        evidenceKey: `${fixture.revisionId}:extra`,
        revisionId: fixture.revisionId,
        taskKey: 'extra',
        depsOrchestrationIds: []
      },
      state: 'running',
      dispatch: { spec: 'Implement extra.', deps: [], dispatchKind: 'child' },
      dispatchId: 'dispatch-node-extra'
    }

    const outcome = await ingestObjectivePlanReport({
      action: ingestAction(fixture),
      binding: fixture.binding,
      context: fixture.contextWith([inFlightDispatch]),
      objectiveStore: fixture.objectiveStore
    })

    expect(outcome).toMatchObject({ effect: 'landed', result: { kind: 'plan-patch-ingested' } })
    const patches = fixture.objectiveStore.listPlanPatches(WATCHER_ID)
    expect(patches).toHaveLength(1)
    expect(patches[0]?.status).toBe('rejected')
    expect(patches[0]?.rejection).toBe('changes-frozen-node:extra')
  })

  it('refuses ingestion without persisting a patch when targetRevisionId is missing', async () => {
    const fixture = repairFixture()
    readReport.mockResolvedValue({
      ok: true,
      role: 'planner',
      path: REPORT_PATH,
      report: { repair: { upsertTasks: [], dropTaskKeys: ['extra'] }, assumptions: [] },
      reportDigest: 'digest-repair-4'
    })

    const outcome = await ingestObjectivePlanReport({
      action: ingestAction(fixture, { targetRevisionId: undefined }),
      binding: fixture.binding,
      context: fixture.contextWith(),
      objectiveStore: fixture.objectiveStore
    })

    expect(outcome).toMatchObject({
      effect: 'not-landed',
      reason: 'planner-repair-target-revision-missing'
    })
    expect(fixture.objectiveStore.listPlanPatches(WATCHER_ID)).toHaveLength(0)
  })

  it('refuses ingestion without persisting a patch when the target revision is unknown', async () => {
    const fixture = repairFixture()
    readReport.mockResolvedValue({
      ok: true,
      role: 'planner',
      path: REPORT_PATH,
      report: { repair: { upsertTasks: [], dropTaskKeys: ['extra'] }, assumptions: [] },
      reportDigest: 'digest-repair-5'
    })

    const outcome = await ingestObjectivePlanReport({
      action: ingestAction(fixture, { targetRevisionId: 'revision-unknown' }),
      binding: fixture.binding,
      context: fixture.contextWith(),
      objectiveStore: fixture.objectiveStore
    })

    expect(outcome).toMatchObject({
      effect: 'not-landed',
      reason: 'planner-repair-target-revision-missing'
    })
    expect(fixture.objectiveStore.listPlanPatches(WATCHER_ID)).toHaveLength(0)
  })
})
