import { describe, expect, it } from 'vitest'
import { decideRepairPlannerAction } from './decide-repair-planner'
import { objectiveAttempts, projectObjectiveReports } from './decision-context'
import { attempt, ledger, projection, snapshot, workerDone } from './decision-test-harness'
import type { ObjectiveAction } from './objective-actions'
import type { ObjectivePlanPatchProjection } from './detail-types'
import type { WatcherLedger } from '../fork-heimdall/ledger-types'

function repairDispatch(
  overrides: Partial<Extract<ObjectiveAction, { kind: 'dispatch-planner' }>> = {}
): Extract<ObjectiveAction, { kind: 'dispatch-planner' }> {
  return {
    kind: 'dispatch-planner',
    capability: 'plan',
    visibility: 'local',
    contentIdentity: 'content-current',
    evidenceKey: 'plan-repair:revision-1:1',
    revisionNumber: 1,
    reason: 'replan-after-failure',
    shape: 'repair',
    repairOrdinal: 1,
    repairRevisionId: 'revision-1',
    ...overrides
  }
}

function planPatch(
  overrides: Partial<ObjectivePlanPatchProjection> = {}
): ObjectivePlanPatchProjection {
  return {
    id: 'patch-1',
    revisionId: 'revision-1',
    createdByDispatchId: 'repair-planner-1',
    repairOrdinal: 1,
    digest: 'patch-digest-1',
    status: 'pending',
    rejection: null,
    touchedTaskKeys: [],
    createdAtMs: 10,
    resolvedAtMs: null,
    ...overrides
  }
}

function decide(world = projection(), rawLedger: WatcherLedger = ledger()) {
  const snap = snapshot(world)
  const attempts = objectiveAttempts(rawLedger)
  const reports = projectObjectiveReports(rawLedger)
  return decideRepairPlannerAction(snap, rawLedger, attempts, reports, 'replan-after-failure')
}

describe('decideRepairPlannerAction', () => {
  it('dispatches the first repair planner attempt at ordinal 1 with no escalation', () => {
    const decision = decide()
    expect(decision.action).toEqual({
      kind: 'dispatch-planner',
      capability: 'plan',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'plan-repair:revision-1:1',
      revisionNumber: 1,
      reason: 'replan-after-failure',
      shape: 'repair',
      repairOrdinal: 1,
      repairRevisionId: 'revision-1'
    })
  })

  it('holds no-action while the latest repair attempt is still in flight', () => {
    const running = ledger([attempt(repairDispatch(), { dispatchId: 'repair-planner-1' })])
    const decision = decide(projection(), running)
    expect(decision).toMatchObject({
      action: null,
      reason: 'planner-in-flight'
    })
  })

  it('holds no-action while the latest repair attempt is indeterminate', () => {
    const stuck = ledger([
      attempt(repairDispatch(), {
        state: 'settled',
        effect: 'indeterminate',
        dispatchId: 'repair-planner-1'
      })
    ])
    const decision = decide(projection(), stuck)
    expect(decision).toMatchObject({ action: null, reason: 'planner-in-flight' })
  })

  it('emits a shape-aware ingest-plan once the repair report lands and no ingestion exists yet', () => {
    const landed = ledger([
      attempt(repairDispatch(), {
        state: 'settled',
        effect: 'landed',
        dispatchId: 'repair-planner-1'
      }),
      workerDone('repair-planner-1', '/outside/repair.json')
    ])
    const decision = decide(projection(), landed)
    expect(decision.action).toEqual({
      kind: 'ingest-plan',
      capability: 'plan',
      visibility: 'local',
      recovery: 'replay-safe',
      contentIdentity: 'content-current',
      evidenceKey: 'repair-planner-1',
      dispatchId: 'repair-planner-1',
      revisionNumber: 1,
      reportPath: '/outside/repair.json',
      shape: 'repair',
      targetRevisionId: 'revision-1'
    })
  })

  it('holds no-action while a landed report is being ingested', () => {
    const ingestAction: ObjectiveAction = {
      kind: 'ingest-plan',
      capability: 'plan',
      visibility: 'local',
      recovery: 'replay-safe',
      contentIdentity: 'content-current',
      evidenceKey: 'repair-planner-1',
      dispatchId: 'repair-planner-1',
      revisionNumber: 1,
      reportPath: '/outside/repair.json',
      shape: 'repair',
      targetRevisionId: 'revision-1'
    }
    const ingesting = ledger([
      attempt(repairDispatch(), {
        state: 'settled',
        effect: 'landed',
        dispatchId: 'repair-planner-1'
      }),
      workerDone('repair-planner-1', '/outside/repair.json'),
      attempt(ingestAction, { dispatchId: 'ingest-repair-1' })
    ])
    const decision = decide(projection(), ingesting)
    expect(decision).toMatchObject({ action: null, reason: 'plan-ingestion-in-flight' })
  })

  it('waits for the projection once ingestion lands but no patch is visible yet', () => {
    const ingestAction: ObjectiveAction = {
      kind: 'ingest-plan',
      capability: 'plan',
      visibility: 'local',
      recovery: 'replay-safe',
      contentIdentity: 'content-current',
      evidenceKey: 'repair-planner-1',
      dispatchId: 'repair-planner-1',
      revisionNumber: 1,
      reportPath: '/outside/repair.json',
      shape: 'repair',
      targetRevisionId: 'revision-1'
    }
    const ingested = ledger([
      attempt(repairDispatch(), {
        state: 'settled',
        effect: 'landed',
        dispatchId: 'repair-planner-1'
      }),
      workerDone('repair-planner-1', '/outside/repair.json'),
      attempt(ingestAction, {
        state: 'settled',
        effect: 'landed',
        dispatchId: 'ingest-repair-1'
      })
    ])
    const decision = decide(projection(), ingested)
    expect(decision).toMatchObject({ action: null, reason: 'projection-refresh-pending' })
  })

  it('holds no-action for a pending patch, deferring to decideObjectivePlan to apply it', () => {
    const world = { ...projection(), patches: [planPatch({ status: 'pending' })] }
    const decision = decide(world)
    expect(decision).toMatchObject({ action: null, reason: 'plan-repair-pending' })
  })

  it('dispatches ordinal 2 with no escalation after a single rejected patch', () => {
    const world = {
      ...projection(),
      patches: [planPatch({ status: 'rejected', repairOrdinal: 1 })]
    }
    const decision = decide(world)
    expect(decision.action).toMatchObject({
      kind: 'dispatch-planner',
      shape: 'repair',
      repairOrdinal: 2,
      evidenceKey: 'plan-repair:revision-1:2'
    })
    expect(decision.action).not.toHaveProperty('approvalRequired')
  })

  it('escalates with approvalRequired on the third repair attempt after two rejected patches', () => {
    const world = {
      ...projection(),
      patches: [
        planPatch({ id: 'patch-1', status: 'rejected', repairOrdinal: 1 }),
        planPatch({ id: 'patch-2', status: 'rejected', repairOrdinal: 2 })
      ]
    }
    const decision = decide(world)
    expect(decision.action).toMatchObject({
      kind: 'dispatch-planner',
      shape: 'repair',
      repairOrdinal: 3,
      approvalRequired: true
    })
  })

  it('starts a fresh, unescalated episode once a patch has applied', () => {
    const world = {
      ...projection(),
      patches: [
        planPatch({ id: 'patch-1', status: 'rejected', repairOrdinal: 1 }),
        planPatch({ id: 'patch-2', status: 'rejected', repairOrdinal: 2 }),
        planPatch({ id: 'patch-3', status: 'applied', repairOrdinal: 3 })
      ]
    }
    const decision = decide(world)
    expect(decision.action).toMatchObject({
      kind: 'dispatch-planner',
      shape: 'repair',
      repairOrdinal: 4
    })
    expect(decision.action).not.toHaveProperty('approvalRequired')
  })
})
