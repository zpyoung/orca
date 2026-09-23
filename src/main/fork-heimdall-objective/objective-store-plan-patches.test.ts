import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PlannerRepairReport } from '../../shared/fork-heimdall-objective/plan-repair-schema'
import type { PlannerReport } from '../../shared/fork-heimdall-objective/plan-schema'
import { ObjectiveDatabase } from './objective-database'
import { ObjectiveStore } from './objective-store'
import { projectPlanPatches } from './objective-store-plan-patches'

const WATCHER_ID = 'watcher-plan-patches-1'
const REPORT: PlannerReport = {
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
const UPSERT_PATCH: PlannerRepairReport = {
  repair: {
    upsertTasks: [
      {
        taskKey: 'task-b',
        title: 'Task B',
        spec: 'Implement B',
        deps: ['task-a'],
        criteria: [{ body: 'B works', shellCheckable: false, checkCommand: null }],
        declaresDependencyChange: false
      }
    ],
    dropTaskKeys: []
  },
  assumptions: [{ claim: 'B needs A done first', dependentTaskKeys: ['task-b'] }]
}
const DROP_PATCH: PlannerRepairReport = {
  repair: { upsertTasks: [], dropTaskKeys: ['task-a'] },
  assumptions: []
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

function ingestAndActivate(): { revisionId: string; digest: string } {
  const revision = store.ingestPlan({
    watcherId: WATCHER_ID,
    revisionNumber: 1,
    dispatchId: 'planner-1',
    report: REPORT,
    digest: 'plan-digest-1',
    createdAtMs: 100
  })
  store.activatePlan({
    watcherId: WATCHER_ID,
    revisionId: revision.revisionId,
    digest: revision.digest,
    approvedAtMs: 200
  })
  return revision
}

describe('ObjectiveStore plan patches', () => {
  it('ingests a patch pending and replays the same dispatch unchanged', () => {
    const revision = ingestAndActivate()
    const args = {
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      dispatchId: 'repair-1',
      repairOrdinal: 0,
      report: UPSERT_PATCH,
      createdAtMs: 500
    }

    const record = store.ingestPlanPatch(args)
    expect(record.status).toBe('pending')
    expect(record.resolvedAtMs).toBeNull()
    expect(record.digest).toBeTruthy()
    expect(store.ingestPlanPatch(args)).toEqual(record)
    expect(store.listPlanPatches(WATCHER_ID)).toEqual([record])
  })

  it('ingests a patch pre-rejected by the caller without dispatching a review', () => {
    const revision = ingestAndActivate()
    const record = store.ingestPlanPatch({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      dispatchId: 'repair-frozen',
      repairOrdinal: 0,
      report: DROP_PATCH,
      createdAtMs: 500,
      rejection: 'changes-frozen-node:task-a'
    })

    expect(record.status).toBe('rejected')
    expect(record.rejection).toBe('changes-frozen-node:task-a')
    expect(record.resolvedAtMs).toBe(500)
  })

  it('rejects a pending patch, is idempotent for the same reason, and refuses a different one', () => {
    const revision = ingestAndActivate()
    const patch = store.ingestPlanPatch({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      dispatchId: 'repair-1',
      repairOrdinal: 0,
      report: UPSERT_PATCH,
      createdAtMs: 500
    })

    const rejected = store.rejectPlanPatch({
      patchId: patch.id,
      rejection: 'revise-verdict',
      resolvedAtMs: 700
    })
    expect(rejected.status).toBe('rejected')
    expect(
      store.rejectPlanPatch({ patchId: patch.id, rejection: 'revise-verdict', resolvedAtMs: 800 })
    ).toEqual(rejected)
    expect(() =>
      store.rejectPlanPatch({ patchId: patch.id, rejection: 'escalate-verdict', resolvedAtMs: 900 })
    ).toThrow(/different reason/)
  })

  it('applies a pending patch, merging its assumptions onto the revision in one transaction', () => {
    const revision = ingestAndActivate()
    const patch = store.ingestPlanPatch({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      dispatchId: 'repair-1',
      repairOrdinal: 0,
      report: UPSERT_PATCH,
      createdAtMs: 500
    })

    const result = store.applyPlanPatch({
      watcherId: WATCHER_ID,
      patchId: patch.id,
      amendedAtMs: 600,
      frozenTaskKeys: []
    })

    expect(result).toMatchObject({ ok: true, revisionId: revision.revisionId, replayed: false })
    expect(store.getPlan(revision.revisionId)?.map((task) => task.taskKey)).toEqual([
      'task-a',
      'task-b'
    ])
    expect(store.getPlanPatch(patch.id)?.status).toBe('applied')
    expect(store.getPlanReport(revision.revisionId)?.assumptions).toEqual([
      { claim: 'B needs A done first', dependentTaskKeys: ['task-b'] }
    ])

    const replay = store.applyPlanPatch({
      watcherId: WATCHER_ID,
      patchId: patch.id,
      amendedAtMs: 999,
      frozenTaskKeys: []
    })
    expect(replay).toEqual({ ...result, replayed: true })
    expect(store.getPlanReport(revision.revisionId)?.assumptions).toHaveLength(1)
  })

  it('refuses to apply a patch that would push merged assumptions past the entry limit', () => {
    const revisionReport: PlannerReport = {
      plan: REPORT.plan,
      assumptions: Array.from({ length: 64 }, (_, i) => ({
        claim: `assumption ${i}`,
        dependentTaskKeys: []
      }))
    }
    const revision = store.ingestPlan({
      watcherId: WATCHER_ID,
      revisionNumber: 1,
      dispatchId: 'planner-1',
      report: revisionReport,
      digest: 'plan-digest-64',
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
      report: UPSERT_PATCH,
      createdAtMs: 500
    })

    const result = store.applyPlanPatch({
      watcherId: WATCHER_ID,
      patchId: patch.id,
      amendedAtMs: 600,
      frozenTaskKeys: []
    })

    if (result.ok || result.reason !== 'assumptions-limit-exceeded') {
      throw new Error('expected an assumptions-limit-exceeded refusal')
    }
    expect(result.detail).toMatch(/64/)
    const stored = store.getPlanPatch(patch.id)
    expect(stored?.status).toBe('rejected')
    expect(stored?.rejection).toMatch(/assumption/i)
    // the task-upsert half of the patch must not have landed either — the whole patch is refused
    expect(store.getPlan(revision.revisionId)?.map((task) => task.taskKey)).toEqual(['task-a'])
    expect(() => store.getPlanReport(revision.revisionId)).not.toThrow()
    expect(store.getPlanReport(revision.revisionId)?.assumptions).toHaveLength(64)
  })

  it('refuses to apply a patch that touches a frozen task, marking the patch rejected', () => {
    const revision = ingestAndActivate()
    const patch = store.ingestPlanPatch({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      dispatchId: 'repair-drop',
      repairOrdinal: 0,
      report: DROP_PATCH,
      createdAtMs: 500
    })

    const result = store.applyPlanPatch({
      watcherId: WATCHER_ID,
      patchId: patch.id,
      amendedAtMs: 600,
      frozenTaskKeys: ['task-a']
    })

    expect(result).toEqual({ ok: false, reason: 'changes-frozen-node', taskKey: 'task-a' })
    const stored = store.getPlanPatch(patch.id)
    expect(stored?.status).toBe('rejected')
    expect(stored?.rejection).toBe('changes-frozen-node:task-a')
    expect(store.getPlan(revision.revisionId)?.map((task) => task.taskKey)).toEqual(['task-a'])
  })

  it('throws when applying an already-rejected patch', () => {
    const revision = ingestAndActivate()
    const patch = store.ingestPlanPatch({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      dispatchId: 'repair-1',
      repairOrdinal: 0,
      report: UPSERT_PATCH,
      createdAtMs: 500,
      rejection: 'revise-verdict'
    })

    expect(() =>
      store.applyPlanPatch({
        watcherId: WATCHER_ID,
        patchId: patch.id,
        amendedAtMs: 600,
        frozenTaskKeys: []
      })
    ).toThrow(/cannot be applied from rejected/)
  })

  it('throws when rejecting an applied patch', () => {
    const revision = ingestAndActivate()
    const patch = store.ingestPlanPatch({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      dispatchId: 'repair-1',
      repairOrdinal: 0,
      report: UPSERT_PATCH,
      createdAtMs: 500
    })
    store.applyPlanPatch({
      watcherId: WATCHER_ID,
      patchId: patch.id,
      amendedAtMs: 600,
      frozenTaskKeys: []
    })

    expect(() =>
      store.rejectPlanPatch({ patchId: patch.id, rejection: 'too-late', resolvedAtMs: 700 })
    ).toThrow(/cannot be rejected from applied/)
  })

  it('lists patches newest first', () => {
    const revision = ingestAndActivate()
    const first = store.ingestPlanPatch({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      dispatchId: 'repair-1',
      repairOrdinal: 0,
      report: UPSERT_PATCH,
      createdAtMs: 500
    })
    const second = store.ingestPlanPatch({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      dispatchId: 'repair-2',
      repairOrdinal: 1,
      report: DROP_PATCH,
      createdAtMs: 600
    })

    expect(store.listPlanPatches(WATCHER_ID)).toEqual([second, first])
  })

  it('rejects a draft revision, freeing the one-draft slot idempotently', () => {
    const draft = store.ingestPlan({
      watcherId: WATCHER_ID,
      revisionNumber: 1,
      dispatchId: 'planner-1',
      report: REPORT,
      digest: 'plan-digest-1',
      createdAtMs: 100
    })

    store.rejectDraftRevision({ watcherId: WATCHER_ID, revisionId: draft.revisionId })
    expect(store.project(WATCHER_ID).revisions[0]?.status).toBe('rejected')
    expect(() =>
      store.rejectDraftRevision({ watcherId: WATCHER_ID, revisionId: draft.revisionId })
    ).not.toThrow()
    expect(() =>
      store.ingestPlan({
        watcherId: WATCHER_ID,
        revisionNumber: 2,
        dispatchId: 'planner-2',
        report: REPORT,
        digest: 'plan-digest-2',
        createdAtMs: 200
      })
    ).not.toThrow()
  })

  it('refuses to reject a non-draft revision', () => {
    const revision = ingestAndActivate()
    expect(() =>
      store.rejectDraftRevision({ watcherId: WATCHER_ID, revisionId: revision.revisionId })
    ).toThrow(/cannot be rejected from approved/)
  })

  it('caps the projection at the newest 1,024 patches out of 1,025 stored', () => {
    const revision = ingestAndActivate()
    for (let i = 0; i < 1_025; i++) {
      store.ingestPlanPatch({
        watcherId: WATCHER_ID,
        revisionId: revision.revisionId,
        dispatchId: `repair-${i}`,
        repairOrdinal: i,
        report: DROP_PATCH,
        createdAtMs: 1_000 + i
      })
    }

    const projected = projectPlanPatches(database.connection(), WATCHER_ID)
    expect(projected).toHaveLength(1_024)
    expect(projected[0]?.createdByDispatchId).toBe('repair-1024')
    expect(projected.at(-1)?.createdByDispatchId).toBe('repair-1')
    expect(projected.some((patch) => patch.createdByDispatchId === 'repair-0')).toBe(false)
  })

  it('projects a repair touching 256 distinct task keys (128 upserted, 128 dropped)', () => {
    const revision = ingestAndActivate()
    const upsertTasks = Array.from({ length: 128 }, (_, i) => ({
      taskKey: `task-up-${i}`,
      title: `Task up ${i}`,
      spec: `Implement up ${i}`,
      deps: [],
      criteria: [{ body: 'works', shellCheckable: false, checkCommand: null }],
      declaresDependencyChange: false
    }))
    const dropTaskKeys = Array.from({ length: 128 }, (_, i) => `task-drop-${i}`)
    store.ingestPlanPatch({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      dispatchId: 'repair-wide',
      repairOrdinal: 0,
      report: { repair: { upsertTasks, dropTaskKeys }, assumptions: [] },
      createdAtMs: 500
    })

    const projection = store.project(WATCHER_ID)
    expect(projection.patches?.[0]?.touchedTaskKeys).toHaveLength(256)
  })
})
