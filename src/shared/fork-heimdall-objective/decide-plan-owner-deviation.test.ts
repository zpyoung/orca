import { describe, expect, it } from 'vitest'
import { createReportValidationProvenance } from '../fork-heimdall/effect-certainty'
import type { EvidenceEntry } from '../fork-heimdall/ledger-types'
import { decideObjective } from './decision'
import {
  attempt,
  ledger,
  projection,
  revision,
  snapshot,
  workerDone
} from './decision-test-harness'
import type { ObjectiveAction } from './objective-actions'

const plannerDispatch: ObjectiveAction = {
  kind: 'dispatch-planner',
  capability: 'plan',
  visibility: 'local',
  contentIdentity: 'content-current',
  evidenceKey: 'plan:1',
  revisionNumber: 1,
  reason: 'initial'
}

describe('objective plan deviations, owner configured', () => {
  it('dispatches the initial planner when an owner is configured', () => {
    const decision = decideObjective(
      snapshot(projection({ revisions: [], nodes: [] })),
      ledger(),
      true
    )
    expect(decision.action).toMatchObject({
      kind: 'dispatch-planner',
      capability: 'plan',
      evidenceKey: 'plan:1',
      revisionNumber: 1,
      reason: 'initial'
    })
    expect('deviation' in decision).toBe(false)
  })

  it('waits without owner deviation while the initial planner is in flight', () => {
    const runningPlanner = attempt(plannerDispatch, { dispatchId: 'planner-1' })
    const plan = projection({ revisions: [], nodes: [] })
    const decision = decideObjective(snapshot(plan), ledger([runningPlanner]), true)
    expect(decision.action).toBeNull()
    expect(decision).toMatchObject({ reason: 'planner-in-flight' })
    expect('deviation' in decision).toBe(false)
  })

  it('ingests a completed valid planner report without owner deviation', () => {
    const runningPlanner = attempt(plannerDispatch, { dispatchId: 'planner-1' })
    const plan = projection({ revisions: [], nodes: [] })
    const decision = decideObjective(
      snapshot(plan),
      ledger([runningPlanner, workerDone('planner-1', '/outside/plan.json')]),
      true
    )
    expect(decision.action).toMatchObject({
      kind: 'ingest-plan',
      capability: 'plan',
      dispatchId: 'planner-1',
      revisionNumber: 1,
      reportPath: '/outside/plan.json'
    })
    expect('deviation' in decision).toBe(false)
  })

  it('routes a completed planner failure to the owner before attempt settlement catches up', () => {
    const runningPlanner = attempt(plannerDispatch, { dispatchId: 'planner-1' })
    const failedReport: EvidenceEntry = {
      kind: 'evidence',
      eventId: 'evidence-planner-1',
      watcherId: 'watcher-1',
      atMs: 40,
      origin: 'owner',
      class: 'fact',
      evidenceKind: 'orchestration-mailbox',
      payload: {
        type: 'worker_done',
        payload: {
          dispatchId: 'planner-1',
          taskId: 'task-planner-1',
          outcome: 'failed',
          reportPath: null,
          filesModified: []
        }
      }
    }
    const plan = projection({ revisions: [], nodes: [] })
    const decision = decideObjective(snapshot(plan), ledger([runningPlanner, failedReport]), true)
    expect(decision.action).toBeNull()
    expect(decision).toMatchObject({
      deviation: { kind: 'plan-failed', reason: 'no-usable-plan' }
    })
  })

  it('emits plan-failed for no-usable-plan instead of replanning', () => {
    const failedPlanner = attempt(plannerDispatch, {
      state: 'settled',
      effect: 'not-landed',
      dispatchId: 'planner-1'
    })
    const plan = projection({ revisions: [], nodes: [] })
    const decision = decideObjective(snapshot(plan), ledger([failedPlanner]), true)
    expect(decision.action).toBeNull()
    expect(decision).toMatchObject({ deviation: { kind: 'plan-failed', reason: 'no-usable-plan' } })
  })

  it('retains malformed planner ingestion provenance in the owner deviation', () => {
    const ingestPlan: ObjectiveAction = {
      kind: 'ingest-plan',
      capability: 'plan',
      visibility: 'local',
      recovery: 'replay-safe',
      contentIdentity: 'content-current',
      evidenceKey: 'planner-1',
      dispatchId: 'planner-1',
      revisionNumber: 1,
      reportPath: '/outside/plan.json'
    }
    const failedIngestion = {
      ...attempt(ingestPlan, {
        state: 'settled',
        effect: 'not-landed',
        dispatchId: 'ingest-plan-attempt',
        reason: 'planner-report-malformed'
      }),
      result: {
        reportValidation: createReportValidationProvenance({
          status: 'rejected',
          code: 'malformed',
          role: 'planner',
          dispatchId: 'planner-1',
          reportPath: '/outside/plan.json',
          detail: 'plan[0].spec: expected string',
          hostVerifiable: true
        })
      }
    }
    const decision = decideObjective(
      snapshot(projection({ revisions: [], nodes: [] })),
      ledger([
        attempt(plannerDispatch, {
          state: 'settled',
          effect: 'landed',
          dispatchId: 'planner-1'
        }),
        workerDone('planner-1', '/outside/plan.json'),
        failedIngestion
      ]),
      true
    )

    expect(decision).toMatchObject({
      action: null,
      deviation: {
        kind: 'plan-failed',
        reason: 'no-usable-plan',
        detail: expect.stringContaining('plan[0].spec: expected string')
      }
    })
  })

  it('still replans automatically for no-usable-plan when no owner is configured', () => {
    const failedPlanner = attempt(plannerDispatch, {
      state: 'settled',
      effect: 'not-landed',
      dispatchId: 'planner-1'
    })
    const plan = projection({ revisions: [], nodes: [] })
    const decision = decideObjective(snapshot(plan), ledger([failedPlanner]))
    expect(decision.action).toMatchObject({
      kind: 'dispatch-planner',
      evidenceKey: 'plan:2',
      reason: 'replan-after-failure'
    })
    expect('deviation' in decision).toBe(false)
  })

  it('emits plan-failed for activation-not-landed instead of replanning', () => {
    const draft = revision({ status: 'draft', approvedAtMs: null })
    const activate: ObjectiveAction = {
      kind: 'activate-plan',
      capability: 'plan',
      visibility: 'local',
      recovery: 'replay-safe',
      contentIdentity: 'content-current',
      evidenceKey: draft.id,
      revisionId: draft.id,
      digest: draft.digest
    }
    const failedActivation = attempt(activate, { state: 'settled', effect: 'not-landed' })
    const plan = projection({ revisions: [draft], nodes: [] })
    const decision = decideObjective(snapshot(plan), ledger([failedActivation]), true)
    expect(decision.action).toBeNull()
    expect(decision).toMatchObject({
      deviation: {
        kind: 'plan-failed',
        reason: 'activation-not-landed',
        revisionId: draft.id,
        revisionNumber: draft.number
      }
    })
  })

  it('still replans automatically for activation-not-landed when no owner is configured', () => {
    const draft = revision({ status: 'draft', approvedAtMs: null })
    const activate: ObjectiveAction = {
      kind: 'activate-plan',
      capability: 'plan',
      visibility: 'local',
      recovery: 'replay-safe',
      contentIdentity: 'content-current',
      evidenceKey: draft.id,
      revisionId: draft.id,
      digest: draft.digest
    }
    const failedActivation = attempt(activate, { state: 'settled', effect: 'not-landed' })
    const plan = projection({ revisions: [draft], nodes: [] })
    const decision = decideObjective(snapshot(plan), ledger([failedActivation]))
    expect(decision.action).toMatchObject({
      kind: 'dispatch-planner',
      reason: 'replan-after-failure'
    })
    expect('deviation' in decision).toBe(false)
  })
})
