import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PlannerReport } from '../../shared/fork-heimdall-objective/plan-schema'
import { ObjectiveDatabase } from './objective-database'
import { ObjectiveStore } from './objective-store'

const WATCHER_ID = 'watcher-store-mutations-1'
const CONTENT_IDENTITY = 'content-1'
const REPORT: PlannerReport = {
  plan: [
    {
      taskKey: 'task-a',
      title: 'Node A',
      spec: 'Implement node A',
      deps: [],
      criteria: [{ body: 'The focused check passes', shellCheckable: true, checkCommand: 'true' }],
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

function criterionId(): string {
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
    approvedAtMs: 101
  })
  const id = store.project(WATCHER_ID).nodes[0]?.criteria[0]?.id
  if (!id) {
    throw new Error('Fixture plan did not produce a criterion')
  }
  return id
}

describe('ObjectiveStore.abandonCheckAttempt', () => {
  it('removes a started, uncompleted check attempt so no row remains at that natural key', () => {
    const criterion = criterionId()
    store.startCheckAttempt({
      watcherId: WATCHER_ID,
      criterionId: criterion,
      contentIdentity: CONTENT_IDENTITY,
      executionHostId: 'local',
      command: 'true',
      epoch: 1,
      startedAtMs: 100
    })
    expect(store.getCheckAttempt(criterion, CONTENT_IDENTITY)).not.toBeNull()

    store.abandonCheckAttempt({ criterionId: criterion, contentIdentity: CONTENT_IDENTITY })

    expect(store.getCheckAttempt(criterion, CONTENT_IDENTITY)).toBeNull()
  })

  it('leaves a completed check attempt untouched, matching the completed_at_ms guard', () => {
    const criterion = criterionId()
    store.startCheckAttempt({
      watcherId: WATCHER_ID,
      criterionId: criterion,
      contentIdentity: CONTENT_IDENTITY,
      executionHostId: 'local',
      command: 'true',
      epoch: 1,
      startedAtMs: 100
    })
    store.completeCheckAttempt({
      criterionId: criterion,
      contentIdentity: CONTENT_IDENTITY,
      exitCode: 0,
      timedOut: false,
      stdoutTail: '',
      stderrTail: '',
      completedAtMs: 110
    })

    store.abandonCheckAttempt({ criterionId: criterion, contentIdentity: CONTENT_IDENTITY })

    expect(store.getCheckAttempt(criterion, CONTENT_IDENTITY)).not.toBeNull()
  })

  it('does nothing when no attempt was started at that natural key', () => {
    const criterion = criterionId()
    expect(() =>
      store.abandonCheckAttempt({ criterionId: criterion, contentIdentity: CONTENT_IDENTITY })
    ).not.toThrow()
  })
})

describe('ObjectiveStore.abandonGateAttempt', () => {
  const gateArgs = {
    watcherId: WATCHER_ID,
    gateName: 'full-suite',
    contentIdentity: CONTENT_IDENTITY,
    executionHostId: 'local',
    command: 'pnpm test',
    epoch: 1,
    startedAtMs: 100
  }

  it('removes a started, uncompleted gate attempt so no row remains at that natural key', () => {
    store.startGateAttempt(gateArgs)
    expect(store.getGateAttempt(WATCHER_ID, gateArgs.gateName, CONTENT_IDENTITY)).not.toBeNull()

    store.abandonGateAttempt({
      watcherId: WATCHER_ID,
      gateName: gateArgs.gateName,
      contentIdentity: CONTENT_IDENTITY
    })

    expect(store.getGateAttempt(WATCHER_ID, gateArgs.gateName, CONTENT_IDENTITY)).toBeNull()
  })

  it('leaves a completed gate attempt untouched, matching the completed_at_ms guard', () => {
    store.startGateAttempt(gateArgs)
    store.completeGateAttempt({
      watcherId: WATCHER_ID,
      gateName: gateArgs.gateName,
      contentIdentity: CONTENT_IDENTITY,
      exitCode: 0,
      timedOut: false,
      stdoutTail: '',
      stderrTail: '',
      completedAtMs: 110
    })

    store.abandonGateAttempt({
      watcherId: WATCHER_ID,
      gateName: gateArgs.gateName,
      contentIdentity: CONTENT_IDENTITY
    })

    expect(store.getGateAttempt(WATCHER_ID, gateArgs.gateName, CONTENT_IDENTITY)).not.toBeNull()
  })
})
