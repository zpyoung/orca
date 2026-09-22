import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ObjectiveEnrollmentPayload } from '../../shared/fork-heimdall-objective/contract-types'
import type { ObjectiveDispatchRecord } from '../../shared/fork-heimdall-objective/parallel-types'
import type { PlannerReport } from '../../shared/fork-heimdall-objective/plan-schema'
import { ObjectiveDatabase } from './objective-database'
import { ObjectiveStore } from './objective-store'

const WATCHER_ID = 'watcher-objective-1'
const REPORT: PlannerReport = {
  plan: [
    {
      taskKey: 'task-a',
      title: 'Secret node title A',
      spec: 'Secret implementer specification A',
      deps: [],
      criteria: [
        { body: 'Secret acceptance body A', shellCheckable: true, checkCommand: 'pnpm check:a' }
      ],
      declaresDependencyChange: false
    },
    {
      taskKey: 'task-b',
      title: 'Secret node title B',
      spec: 'Secret implementer specification B',
      deps: ['task-a'],
      criteria: [{ body: 'Secret acceptance body B', shellCheckable: false, checkCommand: null }],
      declaresDependencyChange: false
    }
  ]
}
const CONTRACT: ObjectiveEnrollmentPayload = {
  objectiveText: 'Implement the requested objective',
  tier: 'standard',
  landingBar: 'files-on-disk',
  maxConcurrency: 1,
  workspaceKind: 'git',
  writeTerritory: ['src/**'],
  roleAgents: {},
  sitterOverrides: {}
}

let database: ObjectiveDatabase
let store: ObjectiveStore

beforeEach(() => {
  database = new ObjectiveDatabase(':memory:')
  store = new ObjectiveStore(database, () => 9_999)
})

afterEach(() => {
  database.close()
})

describe('ObjectiveStore durable dispatches', () => {
  it('persists setup recovery and projects train state across store instances', () => {
    const revision = store.ingestPlan({
      watcherId: WATCHER_ID,
      revisionNumber: 1,
      dispatchId: 'planner-1',
      report: REPORT,
      digest: 'plan-digest-1',
      createdAtMs: 101
    })
    const record: ObjectiveDispatchRecord = {
      attemptFingerprint: 'attempt-node-a',
      watcherId: WATCHER_ID,
      executionHostId: 'local',
      planTaskDigest: 'plan-task-digest-a',
      revisionId: revision.revisionId,
      taskKey: 'task-a',
      dispatchId: 'dispatch-node-a',
      workspaceId: 'worktree-node-a',
      workspacePath: '/workspace/node-a',
      baseCommit: 'base-sha',
      laneTaskKeys: ['task-a', 'task-b'],
      sessionNodeCount: 1,
      state: 'waiting-to-apply',
      commitSha: 'node-commit-sha',
      appliedCommitSha: null,
      reportDigest: 'report-digest-a',
      conflictPaths: [],
      conflictingTaskKeys: [],
      conflictingDispatchIds: [],
      createdAtMs: 700,
      completedAtMs: 800,
      terminalHandle: 'terminal-node-a',
      setupState: 'ready',
      reportPath: '.orca/reports/task-a.json',
      report: {
        taskKey: 'task-a',
        summary: 'Implemented task A',
        filesModified: ['src/a.ts'],
        criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass', note: 'Checked' }]
      },
      task: REPORT.plan[0]!
    }
    store.saveDispatch({
      ...record,
      dispatchId: null,
      workspaceId: 'pending:attempt-node-a',
      workspacePath: 'pending:attempt-node-a',
      state: 'running',
      commitSha: null,
      reportDigest: null,
      completedAtMs: null,
      terminalHandle: null,
      setupState: 'pending',
      reportPath: null,
      report: null
    })
    store.saveDispatch(record)
    store.setParallelNote(WATCHER_ID, 'Train paused by operator edits.')

    const reopened = new ObjectiveStore(database, () => 10_000)
    expect(reopened.getDispatch(record.attemptFingerprint)).toEqual(record)
    expect(reopened.dispatchForId(WATCHER_ID, 'dispatch-node-a')).toEqual(record)
    expect(reopened.listDispatches(WATCHER_ID)).toEqual([record])
    expect(reopened.parallelProjection(WATCHER_ID, { ...CONTRACT, maxConcurrency: 3 })).toEqual({
      effectiveMaxConcurrency: 3,
      runningCount: 1,
      note: 'Train paused by operator edits.',
      dispatches: [record]
    })
    expect(
      reopened.parallelProjection(WATCHER_ID, {
        ...CONTRACT,
        workspaceKind: 'folder',
        maxConcurrency: 3
      })
    ).toMatchObject({
      effectiveMaxConcurrency: 1,
      note: expect.stringContaining('Folder workspaces'),
      runningCount: 1
    })
  })
})
