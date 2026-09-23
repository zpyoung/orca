import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PlannerReport } from '../../shared/fork-heimdall-objective/plan-schema'
import type { RevisionAmendmentPatch } from '../../shared/fork-heimdall-objective/revision-amendment'
import { ObjectiveDatabase } from './objective-database'
import { ObjectiveStore } from './objective-store'

const WATCHER_ID = 'watcher-amend-1'
const REPORT: PlannerReport = {
  plan: [
    {
      taskKey: 'task-a',
      title: 'Task A',
      spec: 'Implement A',
      deps: [],
      criteria: [{ body: 'A is done', shellCheckable: false, checkCommand: null }],
      declaresDependencyChange: false
    },
    {
      taskKey: 'task-b',
      title: 'Task B',
      spec: 'Implement B',
      deps: ['task-a'],
      criteria: [{ body: 'B is done', shellCheckable: false, checkCommand: null }],
      declaresDependencyChange: false
    },
    {
      taskKey: 'task-c',
      title: 'Task C',
      spec: 'Implement C',
      deps: [],
      criteria: [{ body: 'C is done', shellCheckable: false, checkCommand: null }],
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

function dispatch(revisionId: string, taskKey: string, dispatchId: string): void {
  store.recordNodeDispatch({
    watcherId: WATCHER_ID,
    revisionId,
    taskKey,
    orchestrationTaskId: `orchestration-${taskKey}`,
    dispatchId,
    dispatchedAtMs: 300
  })
}

function upsertTask(overrides: {
  taskKey: string
  title?: string
  spec?: string
  deps?: string[]
}): RevisionAmendmentPatch['upsertTasks'][number] {
  return {
    taskKey: overrides.taskKey,
    title: overrides.title ?? `${overrides.taskKey} corrected`,
    spec: overrides.spec ?? `${overrides.taskKey} corrected spec`,
    deps: overrides.deps ?? [],
    criteria: [
      {
        body: `${overrides.taskKey} corrected criterion`,
        shellCheckable: false,
        checkCommand: null
      }
    ],
    declaresDependencyChange: false
  }
}

function nodeState(revisionId: string, taskKey: string): string | undefined {
  return store
    .project(WATCHER_ID)
    .nodes.find((node) => node.revisionId === revisionId && node.taskKey === taskKey)?.state
}

describe('ObjectiveStore.amendRevision', () => {
  it('resets only the named nodes to pending, leaving an untouched dispatched node succeeded', () => {
    const revision = ingestAndActivate()
    dispatch(revision.revisionId, 'task-a', 'dispatch-a')
    dispatch(revision.revisionId, 'task-b', 'dispatch-b')

    const result = store.amendRevision({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      amendedAtMs: 400,
      patch: {
        digest: 'amend-digest-1',
        attestation: 'Corrected B after a failed report',
        upsertTasks: [upsertTask({ taskKey: 'task-b', deps: ['task-a'] })],
        dropTaskKeys: []
      }
    })

    expect(result).toEqual({
      ok: true,
      revisionId: revision.revisionId,
      digest: 'amend-digest-1',
      ordinal: 0,
      replayed: false
    })
    expect(nodeState(revision.revisionId, 'task-a')).toBe('succeeded')
    expect(nodeState(revision.revisionId, 'task-b')).toBe('pending')
    expect(store.getTask(revision.revisionId, 'task-b')?.spec).toBe('task-b corrected spec')
  })

  it('keeps the revision id and approved status, so no node projects as replanned', () => {
    const revision = ingestAndActivate()
    dispatch(revision.revisionId, 'task-a', 'dispatch-a')

    store.amendRevision({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      amendedAtMs: 400,
      patch: {
        digest: 'amend-digest-1',
        attestation: 'Corrected B',
        upsertTasks: [upsertTask({ taskKey: 'task-b', deps: ['task-a'] })],
        dropTaskKeys: []
      }
    })

    const projection = store.project(WATCHER_ID)
    expect(projection.revisions).toHaveLength(1)
    expect(projection.revisions[0]?.id).toBe(revision.revisionId)
    expect(projection.revisions[0]?.status).toBe('approved')
    expect(projection.nodes.some((node) => node.state === 'replanned')).toBe(false)
  })

  it('replays an identical amendment as a no-op instead of duplicating a row', () => {
    const revision = ingestAndActivate()
    const patch: RevisionAmendmentPatch = {
      digest: 'amend-digest-1',
      attestation: 'Corrected B',
      upsertTasks: [upsertTask({ taskKey: 'task-b', deps: ['task-a'] })],
      dropTaskKeys: []
    }
    const args = { watcherId: WATCHER_ID, revisionId: revision.revisionId, amendedAtMs: 400, patch }

    const first = store.amendRevision(args)
    const replay = store.amendRevision({ ...args, amendedAtMs: 401 })
    expect(replay).toEqual({ ...first, replayed: true })

    const count = database
      .connection()
      .prepare('SELECT COUNT(*) AS count FROM revision_amendment WHERE revision_id = ?')
      .get(revision.revisionId) as { count: number }
    expect(count.count).toBe(1)
  })

  it('refuses to drop a task that already succeeded', () => {
    const revision = ingestAndActivate()
    dispatch(revision.revisionId, 'task-c', 'dispatch-c')

    const result = store.amendRevision({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      amendedAtMs: 400,
      patch: {
        digest: 'amend-digest-1',
        attestation: 'Trying to drop completed work',
        upsertTasks: [],
        dropTaskKeys: ['task-c']
      }
    })

    expect(result).toEqual({ ok: false, reason: 'drops-succeeded-node', taskKey: 'task-c' })
    expect(store.getTask(revision.revisionId, 'task-c')).not.toBeNull()
  })

  it('refuses to drop a task whose dispatch is still in flight', () => {
    const revision = ingestAndActivate()

    const result = store.amendRevision({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      amendedAtMs: 400,
      patch: {
        digest: 'amend-digest-1',
        attestation: 'Trying to drop running work',
        upsertTasks: [],
        dropTaskKeys: ['task-c']
      },
      inFlightTaskKeys: ['task-c']
    })

    expect(result).toEqual({ ok: false, reason: 'drops-in-flight-node', taskKey: 'task-c' })
    expect(store.getTask(revision.revisionId, 'task-c')).not.toBeNull()
  })

  it('permits dropping a task whose dispatch already failed', () => {
    const revision = ingestAndActivate()

    const result = store.amendRevision({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      amendedAtMs: 400,
      patch: {
        digest: 'amend-digest-1',
        attestation: 'Dropping work that failed',
        upsertTasks: [],
        dropTaskKeys: ['task-c']
      },
      // the store alone cannot tell "failed" from "never dispatched" — both have no dispatch row;
      // the caller-supplied inFlightTaskKeys (empty here) is what rules out "still running"
      inFlightTaskKeys: []
    })

    expect(result).toEqual({
      ok: true,
      revisionId: revision.revisionId,
      digest: 'amend-digest-1',
      ordinal: 0,
      replayed: false
    })
    expect(store.getTask(revision.revisionId, 'task-c')).toBeNull()
  })

  it('permits dropping a task that was never dispatched', () => {
    const revision = ingestAndActivate()

    const result = store.amendRevision({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      amendedAtMs: 400,
      patch: {
        digest: 'amend-digest-1',
        attestation: 'Removing unneeded task C',
        upsertTasks: [],
        dropTaskKeys: ['task-c']
      }
    })

    expect(result).toEqual({
      ok: true,
      revisionId: revision.revisionId,
      digest: 'amend-digest-1',
      ordinal: 0,
      replayed: false
    })
    expect(store.getTask(revision.revisionId, 'task-c')).toBeNull()
    expect(store.getPlan(revision.revisionId)?.map((task) => task.taskKey)).toEqual([
      'task-a',
      'task-b'
    ])
  })

  it('refuses an amendment that introduces a dependency cycle', () => {
    const revision = ingestAndActivate()

    const result = store.amendRevision({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      amendedAtMs: 400,
      patch: {
        digest: 'amend-digest-1',
        attestation: 'Accidentally cyclic correction',
        upsertTasks: [upsertTask({ taskKey: 'task-a', deps: ['task-b'] })],
        dropTaskKeys: []
      }
    })

    expect(result).toMatchObject({ ok: false, reason: 'invalid-dependency-graph' })
  })

  it('refuses an amendment that introduces a dangling dependency', () => {
    const revision = ingestAndActivate()

    const result = store.amendRevision({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      amendedAtMs: 400,
      patch: {
        digest: 'amend-digest-1',
        attestation: 'Dependency on a task that does not exist',
        upsertTasks: [upsertTask({ taskKey: 'task-c', deps: ['task-does-not-exist'] })],
        dropTaskKeys: []
      }
    })

    expect(result).toMatchObject({ ok: false, reason: 'invalid-dependency-graph' })
  })

  it('surfaces the amendment in the projection', () => {
    const revision = ingestAndActivate()

    store.amendRevision({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      amendedAtMs: 400,
      patch: {
        digest: 'amend-digest-1',
        attestation: 'Corrected B and dropped C',
        upsertTasks: [upsertTask({ taskKey: 'task-b', deps: ['task-a'] })],
        dropTaskKeys: ['task-c']
      }
    })

    const projection = store.project(WATCHER_ID)
    expect(projection.revisions[0]?.amendments).toEqual([
      {
        ordinal: 0,
        digest: 'amend-digest-1',
        amendedAtMs: 400,
        attestation: 'Corrected B and dropped C',
        touchedTaskKeys: ['task-b', 'task-c']
      }
    ])
  })

  it('purges a watcher with amendments without violating the plan_revision foreign key', () => {
    const revision = ingestAndActivate()
    store.amendRevision({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      amendedAtMs: 400,
      patch: {
        digest: 'amend-digest-1',
        attestation: 'Corrected B',
        upsertTasks: [upsertTask({ taskKey: 'task-b', deps: ['task-a'] })],
        dropTaskKeys: []
      }
    })

    expect(() => store.purge(WATCHER_ID)).not.toThrow()
    const count = database
      .connection()
      .prepare('SELECT COUNT(*) AS count FROM revision_amendment')
      .get() as { count: number }
    expect(count.count).toBe(0)
  })

  it('invalidates changed criterion checks and every prior review verdict', () => {
    const revision = ingestAndActivate()
    const criterionId = store.project(WATCHER_ID).nodes.find((node) => node.taskKey === 'task-a')!
      .criteria[0]!.id
    store.startCheckAttempt({
      watcherId: WATCHER_ID,
      criterionId,
      contentIdentity: 'content-1',
      executionHostId: 'local',
      command: 'true',
      epoch: 1,
      startedAtMs: 210
    })
    store.completeCheckAttempt({
      criterionId,
      contentIdentity: 'content-1',
      exitCode: 0,
      timedOut: false,
      stdoutTail: '',
      stderrTail: '',
      completedAtMs: 220
    })
    store.recordVerdict({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      dispatchId: 'review-before-amendment',
      role: 'reviewer',
      contentIdentity: 'content-1',
      report: {
        verdict: 'approve',
        criteriaResults: REPORT.plan.map((task) => ({
          taskKey: task.taskKey,
          criterionIndex: 0,
          result: 'pass' as const,
          note: 'Passed before amendment'
        })),
        summary: 'Approved before amendment'
      },
      reportDigest: 'review-digest',
      createdAtMs: 230
    })

    store.amendRevision({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      amendedAtMs: 400,
      patch: {
        digest: 'amend-digest-invalidates-evidence',
        attestation: 'The criterion and review evidence are now stale',
        upsertTasks: [upsertTask({ taskKey: 'task-a' })],
        dropTaskKeys: []
      }
    })

    expect(store.getCheckAttempt(criterionId, 'content-1')).toBeNull()
    expect(store.hasVerdict('review-before-amendment')).toBe(false)
  })

  it('refuses to upsert a frozen task with nothing written', () => {
    const revision = ingestAndActivate()

    const result = store.amendRevision({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      amendedAtMs: 400,
      patch: {
        digest: 'amend-digest-1',
        attestation: 'Trying to touch a frozen node',
        upsertTasks: [upsertTask({ taskKey: 'task-a' })],
        dropTaskKeys: []
      },
      frozenTaskKeys: ['task-a']
    })

    expect(result).toEqual({ ok: false, reason: 'changes-frozen-node', taskKey: 'task-a' })
    expect(store.getTask(revision.revisionId, 'task-a')?.spec).toBe('Implement A')
    const count = database
      .connection()
      .prepare('SELECT COUNT(*) AS count FROM revision_amendment WHERE revision_id = ?')
      .get(revision.revisionId) as { count: number }
    expect(count.count).toBe(0)
  })

  it('refuses to drop a frozen task', () => {
    const revision = ingestAndActivate()

    const result = store.amendRevision({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      amendedAtMs: 400,
      patch: {
        digest: 'amend-digest-1',
        attestation: 'Trying to drop a frozen node',
        upsertTasks: [],
        dropTaskKeys: ['task-c']
      },
      frozenTaskKeys: ['task-c']
    })

    expect(result).toEqual({ ok: false, reason: 'changes-frozen-node', taskKey: 'task-c' })
    expect(store.getTask(revision.revisionId, 'task-c')).not.toBeNull()
  })

  it('permits an amendment that leaves frozen task keys untouched', () => {
    const revision = ingestAndActivate()

    const result = store.amendRevision({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      amendedAtMs: 400,
      patch: {
        digest: 'amend-digest-1',
        attestation: 'Corrected B, task-a is frozen',
        upsertTasks: [upsertTask({ taskKey: 'task-b', deps: ['task-a'] })],
        dropTaskKeys: []
      },
      frozenTaskKeys: ['task-a']
    })

    expect(result).toEqual({
      ok: true,
      revisionId: revision.revisionId,
      digest: 'amend-digest-1',
      ordinal: 0,
      replayed: false
    })
  })

  it('keeps stored assumptions across an amendment, filtering dependentTaskKeys to surviving tasks', () => {
    const reportWithAssumptions: PlannerReport = {
      ...REPORT,
      assumptions: [
        { claim: 'A and C share a config format', dependentTaskKeys: ['task-a', 'task-c'] },
        { claim: 'B needs no external service', dependentTaskKeys: ['task-b'] }
      ]
    }
    const revision = store.ingestPlan({
      watcherId: WATCHER_ID,
      revisionNumber: 1,
      dispatchId: 'planner-1',
      report: reportWithAssumptions,
      digest: 'plan-digest-1',
      createdAtMs: 100
    })
    store.activatePlan({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      digest: revision.digest,
      approvedAtMs: 200
    })

    store.amendRevision({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      amendedAtMs: 400,
      patch: {
        digest: 'amend-digest-1',
        attestation: 'Dropping task C',
        upsertTasks: [],
        dropTaskKeys: ['task-c']
      }
    })

    expect(store.getPlanReport(revision.revisionId)?.assumptions).toEqual([
      { claim: 'A and C share a config format', dependentTaskKeys: ['task-a'] },
      { claim: 'B needs no external service', dependentTaskKeys: ['task-b'] }
    ])
  })

  it('leaves assumptions undeclared for a legacy revision whose stored report omitted them', () => {
    const revision = ingestAndActivate()

    store.amendRevision({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      amendedAtMs: 400,
      patch: {
        digest: 'amend-digest-1',
        attestation: 'Correcting B on a pre-assumptions plan',
        upsertTasks: [upsertTask({ taskKey: 'task-b', deps: ['task-a'] })],
        dropTaskKeys: []
      }
    })

    expect(store.getPlanReport(revision.revisionId)?.assumptions).toBeUndefined()
  })

  it('rejects amending a revision that is not approved', () => {
    const revision = store.ingestPlan({
      watcherId: WATCHER_ID,
      revisionNumber: 1,
      dispatchId: 'planner-1',
      report: REPORT,
      digest: 'plan-digest-1',
      createdAtMs: 100
    })

    expect(() =>
      store.amendRevision({
        watcherId: WATCHER_ID,
        revisionId: revision.revisionId,
        amendedAtMs: 400,
        patch: {
          digest: 'amend-digest-1',
          attestation: 'Cannot amend a draft',
          upsertTasks: [upsertTask({ taskKey: 'task-b', deps: ['task-a'] })],
          dropTaskKeys: []
        }
      })
    ).toThrow(/cannot be amended from draft/)
  })
})
