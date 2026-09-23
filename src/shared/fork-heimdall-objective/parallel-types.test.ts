import { describe, expect, it } from 'vitest'
import { OBJECTIVE_DISPATCH_TASK_SNAPSHOT_MAX_BYTES } from './contract-types'
import { ObjectiveDispatchRecordSchema, type ObjectiveDispatchRecord } from './parallel-types'
import type { ObjectivePlanTask } from './plan-schema'

function planTask(taskKey: string, spec: string): ObjectivePlanTask {
  return {
    taskKey,
    title: `Task ${taskKey}`,
    spec,
    deps: [],
    criteria: [{ body: `${taskKey} works`, shellCheckable: false, checkCommand: null }],
    declaresDependencyChange: false
  }
}

function dispatchRecord(task: ObjectivePlanTask): ObjectiveDispatchRecord {
  return {
    attemptFingerprint: 'fingerprint-1',
    watcherId: 'watcher-1',
    executionHostId: 'local',
    revisionId: 'revision-1',
    taskKey: task.taskKey,
    planTaskDigest: 'plan-digest-1',
    dispatchId: 'dispatch-1',
    workspaceId: 'workspace-1',
    workspacePath: '/workspaces/1',
    baseCommit: 'base-commit',
    laneTaskKeys: [task.taskKey],
    sessionNodeCount: 1,
    state: 'running',
    commitSha: null,
    appliedCommitSha: null,
    reportDigest: null,
    conflictPaths: [],
    conflictingTaskKeys: [],
    conflictingDispatchIds: [],
    createdAtMs: 10,
    completedAtMs: null,
    terminalHandle: null,
    setupState: 'ready',
    reportPath: null,
    report: null,
    task
  }
}

describe('ObjectiveDispatchRecordSchema task snapshot cap', () => {
  it('accepts a task snapshot exactly at the byte cap', () => {
    // pad spec so the whole serialized task lands exactly at the cap
    const probeBytes = new TextEncoder().encode(JSON.stringify(planTask('at-cap', ''))).byteLength
    const spec = 's'.repeat(OBJECTIVE_DISPATCH_TASK_SNAPSHOT_MAX_BYTES - probeBytes)
    const record = dispatchRecord(planTask('at-cap', spec))
    expect(new TextEncoder().encode(JSON.stringify(record.task)).byteLength).toBe(
      OBJECTIVE_DISPATCH_TASK_SNAPSHOT_MAX_BYTES
    )
    expect(ObjectiveDispatchRecordSchema.safeParse(record).success).toBe(true)
  })

  it('rejects a task snapshot one byte over the cap, naming the size limit', () => {
    const probeBytes = new TextEncoder().encode(JSON.stringify(planTask('over-cap', ''))).byteLength
    const spec = 's'.repeat(OBJECTIVE_DISPATCH_TASK_SNAPSHOT_MAX_BYTES - probeBytes + 1)
    const record = dispatchRecord(planTask('over-cap', spec))
    const result = ObjectiveDispatchRecordSchema.safeParse(record)
    expect(result.success).toBe(false)
    expect(
      result.success ? '' : result.error.issues.map((issue) => issue.message).join('\n')
    ).toContain(`${OBJECTIVE_DISPATCH_TASK_SNAPSHOT_MAX_BYTES} bytes`)
  })
})
