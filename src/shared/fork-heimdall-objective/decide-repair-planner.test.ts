import { describe, expect, it } from 'vitest'
import { decideRepairPlannerAction } from './decide-repair-planner'
import { objectiveAttempts, projectObjectiveReports } from './decision-context'
import {
  attempt,
  ledger,
  projection,
  revision,
  snapshot,
  workerDone
} from './decision-test-harness'
import type { ObjectiveAction } from './objective-actions'
import type { ObjectivePlanPatchProjection } from './detail-types'
import type { LedgerEntry, WatcherLedger } from '../fork-heimdall/ledger-types'

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
    plannerMode: 'repair',
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

function decide(
  world = projection(),
  rawLedger: WatcherLedger = ledger(),
  reason: Extract<ObjectiveAction, { kind: 'dispatch-planner' }>['reason'] = 'replan-after-failure'
) {
  const snap = snapshot(world)
  const attempts = objectiveAttempts(rawLedger)
  const reports = projectObjectiveReports(rawLedger)
  return decideRepairPlannerAction(snap, rawLedger, attempts, reports, reason)
}

/** A repair report the ingest step could not even read (missing file, non-JSON): the ingest-plan
 *  attempt settles not-landed and no plan patch is ever stored for its ordinal. */
function unreadableRepairRound(ordinal: number): LedgerEntry[] {
  const dispatchId = `repair-planner-${ordinal}`
  const ingestDispatchId = `ingest-repair-${ordinal}`
  return [
    attempt(
      repairDispatch({
        evidenceKey: `plan-repair:revision-1:${ordinal}`,
        repairOrdinal: ordinal
      }),
      { state: 'settled', effect: 'landed', dispatchId }
    ),
    workerDone(dispatchId, `/outside/repair-${ordinal}.json`),
    attempt(
      {
        kind: 'ingest-plan',
        capability: 'plan',
        visibility: 'local',
        recovery: 'replay-safe',
        contentIdentity: 'content-current',
        evidenceKey: dispatchId,
        dispatchId,
        revisionNumber: 1,
        reportPath: `/outside/repair-${ordinal}.json`,
        plannerMode: 'repair',
        targetRevisionId: 'revision-1'
      },
      { state: 'settled', effect: 'not-landed', dispatchId: ingestDispatchId }
    )
  ]
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
      plannerMode: 'repair',
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
      plannerMode: 'repair',
      targetRevisionId: 'revision-1'
    })
  })

  it('sources the ingest revisionNumber from the originating dispatch rather than the current revision projection', () => {
    // the active revision's own number can diverge from what an in-flight dispatch actually
    // carried (e.g. an owner-directed repair minted before this world snapshot); the ingest
    // action must still match the dispatch that produced it, or ingestion rejects it (C1)
    const world = { ...projection(), revisions: [revision({ number: 7 })] }
    const landed = ledger([
      attempt(repairDispatch({ revisionNumber: 3, reason: 'owner-directed' }), {
        state: 'settled',
        effect: 'landed',
        dispatchId: 'repair-planner-1'
      }),
      workerDone('repair-planner-1', '/outside/repair.json')
    ])
    const decision = decide(world, landed)
    expect(decision.action).toMatchObject({ kind: 'ingest-plan', revisionNumber: 3 })
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
      plannerMode: 'repair',
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
      plannerMode: 'repair',
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
      plannerMode: 'repair',
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
      plannerMode: 'repair',
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
      plannerMode: 'repair',
      repairOrdinal: 4
    })
    expect(decision.action).not.toHaveProperty('approvalRequired')
  })

  it('escalates instead of dispatching a third planner attempt after two unreadable repair reports', () => {
    const rawLedger = ledger([...unreadableRepairRound(1), ...unreadableRepairRound(2)])
    const decision = decide(projection(), rawLedger)
    expect(decision.action).toMatchObject({
      kind: 'dispatch-planner',
      plannerMode: 'repair',
      repairOrdinal: 3,
      approvalRequired: true
    })
  })

  it('escalates on an owner-directed episode too, not just the default replan reason', () => {
    const rawLedger = ledger([...unreadableRepairRound(1), ...unreadableRepairRound(2)])
    const decision = decide(projection(), rawLedger, 'owner-directed')
    expect(decision.action).toMatchObject({
      kind: 'dispatch-planner',
      plannerMode: 'repair',
      repairOrdinal: 3,
      approvalRequired: true
    })
  })

  it('does not escalate after a single unreadable repair report', () => {
    const rawLedger = ledger([...unreadableRepairRound(1)])
    const decision = decide(projection(), rawLedger)
    expect(decision.action).toMatchObject({
      kind: 'dispatch-planner',
      plannerMode: 'repair',
      repairOrdinal: 2
    })
    expect(decision.action).not.toHaveProperty('approvalRequired')
  })
})
