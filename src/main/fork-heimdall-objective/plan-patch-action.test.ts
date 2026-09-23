import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecuteContext } from '../../shared/fork-heimdall/kind-contract'
import type { ObjectiveAction } from '../../shared/fork-heimdall-objective/objective-actions'
import type { PlannerRepairReport } from '../../shared/fork-heimdall-objective/plan-repair-schema'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import type { PlannerReport } from '../../shared/fork-heimdall-objective/plan-schema'
import { ObjectiveDatabase } from './objective-database'
import type { ObjectiveSnapshotBinding } from './execution-context'
import { executeApplyPlanPatch } from './plan-patch-action'
import { ObjectiveStore, type ObjectivePlanPatchRecord } from './objective-store'

const WATCHER_ID = 'watcher-1'

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

const DROP_EXTRA_REPORT: PlannerRepairReport = {
  repair: { upsertTasks: [], dropTaskKeys: ['extra'] },
  assumptions: []
}

const opened: ObjectiveDatabase[] = []

afterEach(() => {
  for (const item of opened) {
    item.close()
  }
  opened.length = 0
})

async function patchFixture(): Promise<{
  objectiveStore: ObjectiveStore
  revisionId: string
  binding: ObjectiveSnapshotBinding
  patch: ObjectivePlanPatchRecord
}> {
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
  const patch = objectiveStore.ingestPlanPatch({
    watcherId: WATCHER_ID,
    revisionId: revision.revisionId,
    dispatchId: 'dispatch-planner-repair-1',
    repairOrdinal: 1,
    report: DROP_EXTRA_REPORT,
    createdAtMs: 3
  })
  const binding = { enrollment: { watcherId: WATCHER_ID } } as unknown as ObjectiveSnapshotBinding
  return { objectiveStore, revisionId: revision.revisionId, binding, patch }
}

function applyAction(
  patch: ObjectivePlanPatchRecord
): Extract<ObjectiveAction, { kind: 'apply-plan-patch' }> {
  return {
    kind: 'apply-plan-patch',
    capability: 'plan',
    visibility: 'local',
    contentIdentity: 'content-1',
    evidenceKey: `plan-patch:${patch.id}`,
    recovery: 'replay-safe',
    revisionId: patch.revisionId,
    patchId: patch.id,
    digest: patch.digest
  }
}

function context(entries: unknown[] = []): ExecuteContext<ObjectiveWorld> {
  return {
    snapshot: { contentIdentity: 'content-1', world: { plan: { nodes: [] } } },
    ledger: { watcherId: WATCHER_ID, entries },
    lease: { assertHeld: vi.fn(async () => undefined) },
    dispatchWorker: vi.fn()
  } as unknown as ExecuteContext<ObjectiveWorld>
}

describe('executeApplyPlanPatch', () => {
  it('applies a pending patch, dropping the named task from the revision', async () => {
    const fixture = await patchFixture()
    const outcome = await executeApplyPlanPatch({
      action: applyAction(fixture.patch),
      binding: fixture.binding,
      context: context(),
      objectiveStore: fixture.objectiveStore
    })

    expect(outcome).toMatchObject({
      effect: 'landed',
      result: { kind: 'plan-patch-applied', patchId: fixture.patch.id }
    })
    const stored = fixture.objectiveStore.getPlanPatch(fixture.patch.id)
    expect(stored?.status).toBe('applied')
    const plan = fixture.objectiveStore.getPlan(fixture.revisionId)
    expect(plan?.map((task) => task.taskKey)).toEqual(['core'])
  })

  it('rejects (without failing the attempt) a patch that touches a task with an in-flight dispatch', async () => {
    const fixture = await patchFixture()
    const inFlightDispatch = {
      eventId: 'attempt-node-extra',
      watcherId: WATCHER_ID,
      atMs: 4,
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

    const outcome = await executeApplyPlanPatch({
      action: applyAction(fixture.patch),
      binding: fixture.binding,
      context: context([inFlightDispatch]),
      objectiveStore: fixture.objectiveStore
    })

    expect(outcome).toMatchObject({
      effect: 'landed',
      result: {
        kind: 'plan-patch-rejected',
        patchId: fixture.patch.id,
        reason: 'changes-frozen-node',
        taskKey: 'extra'
      }
    })
    const stored = fixture.objectiveStore.getPlanPatch(fixture.patch.id)
    expect(stored?.status).toBe('rejected')
    expect(stored?.rejection).toBe('changes-frozen-node:extra')
  })

  it('refuses an unknown patch id without touching the store', async () => {
    const fixture = await patchFixture()
    const outcome = await executeApplyPlanPatch({
      action: { ...applyAction(fixture.patch), patchId: 'missing-patch' },
      binding: fixture.binding,
      context: context(),
      objectiveStore: fixture.objectiveStore
    })

    expect(outcome).toEqual({ effect: 'not-landed', reason: 'apply-plan-patch-not-found' })
    expect(fixture.objectiveStore.getPlanPatch(fixture.patch.id)?.status).toBe('pending')
  })

  it('refuses a digest that no longer matches the stored patch', async () => {
    const fixture = await patchFixture()
    const outcome = await executeApplyPlanPatch({
      action: { ...applyAction(fixture.patch), digest: 'stale-digest' },
      binding: fixture.binding,
      context: context(),
      objectiveStore: fixture.objectiveStore
    })

    expect(outcome).toEqual({ effect: 'not-landed', reason: 'apply-plan-patch-not-found' })
    expect(fixture.objectiveStore.getPlanPatch(fixture.patch.id)?.status).toBe('pending')
  })
})
